#!/usr/bin/env python3
"""
Dhirna — Pont local USB iOS (usbmuxd + pcapd + notifications Darwin).
Communication 100 % par tube stdout JSONL avec le processus parent dhirna-desktop :
- Zéro port réseau ouvert, zéro écriture de paquets, zéro inspection du payload.
- Surveille en mémoire vive les compteurs d'octets d'en-tête pour les réseaux sociaux
  (Instagram, TikTok, Snapchat, Facebook, X, Reddit, YouTube) et les événements
  de verrouillage/extinction d'écran Darwin.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import secrets
import sys
import threading
import time
from typing import Any

SESSION_SALT = secrets.token_bytes(16)

WINDOW_SLOTS = 8
SLOT_MS = 500
WINDOW_DURATION_SEC = (WINDOW_SLOTS * SLOT_MS) / 1000.0  # 4.0 s

HIGH_KBS = 20.0
LOW_KBS = 10.0
CONFIRM_MS = 1_500
TTL_WITH_LOCK_MS = 10_000
TTL_NO_LOCK_MS = 8_000
APP_SWITCH_QUIET_MS = 2_500
OTHER_APP_BURST_KBS = 15.0
LOCKCOMPLETE_COALESCE_MS = 380

LOCK_NOTIFICATIONS = (
    "com.apple.springboard.hasBlankedScreen",
    "com.apple.springboard.lockcomplete",
    "com.apple.springboard.lockstate",
)

BUNDLE_ID_TO_APP = {
    "com.burbn.instagram": "instagram",
    "com.zhiliaoapp.musically": "tiktok",
    "com.ss.iphone.ugc.Aweme": "tiktok",
    "com.ss.iphone.ugc.TikTok": "tiktok",
    "com.toyopagroup.picaboo": "snapchat",
    "com.facebook.Facebook": "facebook",
    "com.atebits.Tweetie2": "x",
    "com.reddit.Reddit": "reddit",
    "com.google.ios.youtube": "shorts",
}

FALLBACK_PROC_TO_APP = {
    "Instagram": "instagram",
    "TikTok": "tiktok",
    "Aweme": "tiktok",
    "Musically": "tiktok",
    "Snapchat": "snapchat",
    "Facebook": "facebook",
    "Twitter": "x",
    "X": "x",
    "Reddit": "reddit",
    "YouTube": "shorts",
}

TRACKED_APPS = ("instagram", "tiktok", "snapchat", "facebook", "x", "reddit", "shorts")

SYSTEM_BG_PROCS = {
    "",
    "mDNSResponder",
    "apsd",
    "nsurlsessiond",
    "cloudd",
    "trustd",
    "networkservicepr",
    "symptomsd",
    "dasd",
    "duetexpertd",
    "biomed",
    "identityservices",
    "imagent",
    "commcenter",
    "CommCenter",
    "wifid",
    "configd",
    "kernel_task",
    "<kernel/nat>",
}


def now_ms() -> int:
    return int(time.monotonic() * 1000)


def anon_id(raw_serial: str) -> str:
    digest = hashlib.blake2s(raw_serial.encode("utf-8"), key=SESSION_SALT, digest_size=3).hexdigest()
    return f"ios-{digest}"


def emit_json(payload: dict[str, Any]) -> None:
    try:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        os._exit(0)


class SlidingByteWindow:
    __slots__ = ("_buckets", "_current_slot")

    def __init__(self) -> None:
        self._buckets = [0] * WINDOW_SLOTS
        self._current_slot: int | None = None

    def _advance(self, slot: int) -> None:
        if self._current_slot is None:
            self._current_slot = slot
            return
        if slot <= self._current_slot:
            return
        steps = slot - self._current_slot
        if steps >= WINDOW_SLOTS:
            for i in range(WINDOW_SLOTS):
                self._buckets[i] = 0
        else:
            for s in range(self._current_slot + 1, slot + 1):
                self._buckets[s % WINDOW_SLOTS] = 0
        self._current_slot = slot

    def add(self, ts_ms: int, nbytes: int) -> None:
        if nbytes <= 0:
            return
        slot = ts_ms // SLOT_MS
        self._advance(slot)
        self._buckets[slot % WINDOW_SLOTS] += int(nbytes)

    def rate_kbs(self, ts_ms: int) -> float:
        slot = ts_ms // SLOT_MS
        self._advance(slot)
        return (sum(self._buckets) / 1024.0) / WINDOW_DURATION_SEC

    def clear(self) -> None:
        for i in range(WINDOW_SLOTS):
            self._buckets[i] = 0
        self._current_slot = None


class AppStreamTracker:
    def __init__(self, app: str) -> None:
        self.app = app
        self.win = SlidingByteWindow()
        self.above_high_since_ms: int | None = None
        self.last_above_low_ms: int | None = None
        self.active = False

    def reset(self) -> None:
        self.win.clear()
        self.above_high_since_ms = None
        self.last_above_low_ms = None
        self.active = False

    def add_bytes(self, ts_ms: int, nbytes: int, screen_locked: bool | None) -> None:
        if screen_locked is True:
            return
        self.win.add(ts_ms, nbytes)

    def evaluate(
        self,
        ts_ms: int,
        screen_locked: bool | None,
        lock_signal_seen: bool,
        other_app_active: bool = False,
    ) -> bool:
        if screen_locked is True:
            self.reset()
            return False

        rate = self.win.rate_kbs(ts_ms)
        if rate >= LOW_KBS:
            self.last_above_low_ms = ts_ms

        if rate >= HIGH_KBS:
            if self.above_high_since_ms is None:
                self.above_high_since_ms = ts_ms
            elif ts_ms - self.above_high_since_ms >= CONFIRM_MS:
                self.active = True
        else:
            self.above_high_since_ms = None

        if self.active:
            quiet_for = (
                (ts_ms - self.last_above_low_ms)
                if self.last_above_low_ms is not None
                else 999_999
            )
            ttl = TTL_WITH_LOCK_MS if lock_signal_seen else TTL_NO_LOCK_MS
            # Cut faster if the user clearly switched to another non-distracting app
            if other_app_active and quiet_for >= APP_SWITCH_QUIET_MS:
                self.active = False
                self.above_high_since_ms = None
            elif quiet_for > ttl:
                self.active = False
                self.above_high_since_ms = None

        return self.active


def watch_parent_stdin() -> None:
    try:
        while sys.stdin.read(1024):
            pass
    except Exception:
        pass
    os._exit(0)


async def list_usb_serials(usbmux_mod: Any) -> set[str]:
    try:
        raw = usbmux_mod.list_devices()
        connected = await raw if inspect.isawaitable(raw) else raw
        return {
            d.serial
            for d in connected
            if getattr(d, "is_usb", getattr(d, "connection_type", "USB") == "USB")
        }
    except Exception:
        return set()


async def run_bridge() -> None:
    from pymobiledevice3 import usbmux
    from pymobiledevice3.exceptions import (
        NotPairedError,
        NotTrustedError,
        PairingDialogResponsePendingError,
        PairingError,
        UserDeniedPairingError,
    )
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.installation_proxy import InstallationProxyService
    from pymobiledevice3.services.notification_proxy import NotificationProxyService
    from pymobiledevice3.services.pcapd import DevicePacket, PcapdService

    readings: dict[str, dict[str, Any]] = {}
    workers: dict[str, asyncio.Task[None]] = {}

    def publish_now() -> None:
        emit_json({"type": "ios_snapshot", "devices": list(readings.values())})

    async def resolve_proc_map(ld: Any) -> dict[str, str]:
        proc_map = dict(FALLBACK_PROC_TO_APP)
        try:
            async with InstallationProxyService(lockdown=ld) as ip:
                apps = await ip.get_apps(
                    application_type="User",
                    calculate_sizes=False,
                    bundle_identifiers=list(BUNDLE_ID_TO_APP.keys()),
                )
                for bid, app_key in BUNDLE_ID_TO_APP.items():
                    info = apps.get(bid)
                    if isinstance(info, dict):
                        exe = str(info.get("CFBundleExecutable", "")).strip()
                        if exe:
                            proc_map[exe[:16]] = app_key
        except Exception:
            pass
        return proc_map

    async def monitor_device(serial: str) -> None:
        dev_id = anon_id(serial)
        trackers = {app: AppStreamTracker(app) for app in TRACKED_APPS}
        other_app_win = SlidingByteWindow()
        screen_locked: bool | None = None
        lock_signal_seen = False
        last_lockcomplete_ms = -10_000

        def set_state(health: str, active: bool, app: str | None) -> None:
            prev = readings.get(dev_id)
            nxt = {
                "id": dev_id,
                "platform": "ios",
                "health": health,
                "active": active,
                "app": app,
            }
            readings[dev_id] = nxt
            if prev != nxt:
                publish_now()

        def recompute(ts_ms: int) -> None:
            other_active = other_app_win.rate_kbs(ts_ms) >= OTHER_APP_BURST_KBS
            active_app: str | None = None
            for app_key in TRACKED_APPS:
                if trackers[app_key].evaluate(
                    ts_ms, screen_locked, lock_signal_seen, other_app_active=other_active
                ):
                    active_app = app_key
                    break
            set_state("ok", active_app is not None, active_app)

        while True:
            try:
                async with await create_using_usbmux(
                    serial=serial, connection_type="USB", autopair=True
                ) as ld:
                    proc_map = await resolve_proc_map(ld)
                    set_state("ok", False, None)

                    async def watch_locks() -> None:
                        nonlocal screen_locked, lock_signal_seen, last_lockcomplete_ms
                        try:
                            async with NotificationProxyService(lockdown=ld, insecure=True) as np:
                                for name in LOCK_NOTIFICATIONS:
                                    await np.notify_register_dispatch(name)
                                async for name in np.receive_notification():
                                    t_ms = now_ms()
                                    lock_signal_seen = True
                                    if name in (
                                        "com.apple.springboard.hasBlankedScreen",
                                        "com.apple.springboard.lockcomplete",
                                    ):
                                        if name == "com.apple.springboard.lockcomplete":
                                            last_lockcomplete_ms = t_ms
                                        screen_locked = True
                                        other_app_win.clear()
                                        for tr in trackers.values():
                                            tr.reset()
                                        recompute(t_ms)
                                    elif name == "com.apple.springboard.lockstate":
                                        if t_ms - last_lockcomplete_ms > LOCKCOMPLETE_COALESCE_MS:
                                            screen_locked = False
                                            recompute(t_ms)
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            return

                    async def watch_packets() -> None:
                        async with PcapdService(lockdown=ld) as pcap:
                            async for raw_pkt in pcap.watch(packets_count=-1):
                                if isinstance(raw_pkt, (bytes, bytearray)):
                                    pkt = DevicePacket.parse(raw_pkt)
                                else:
                                    pkt = raw_pkt
                                comm = getattr(pkt, "comm", "") or ""
                                ecomm = getattr(pkt, "ecomm", "") or ""
                                pkt_len = int(getattr(pkt, "packet_length", 0) or 0)
                                t_ms = now_ms()
                                app_key = proc_map.get(comm) or proc_map.get(ecomm)
                                if app_key:
                                    trackers[app_key].add_bytes(t_ms, pkt_len, screen_locked)
                                    recompute(t_ms)
                                elif (
                                    screen_locked is not True
                                    and comm not in SYSTEM_BG_PROCS
                                    and ecomm not in SYSTEM_BG_PROCS
                                ):
                                    other_app_win.add(t_ms, pkt_len)

                    async def tick_eval() -> None:
                        while True:
                            await asyncio.sleep(0.5)
                            recompute(now_ms())

                    tasks = [
                        asyncio.create_task(watch_locks()),
                        asyncio.create_task(watch_packets()),
                        asyncio.create_task(tick_eval()),
                    ]
                    try:
                        done, pending = await asyncio.wait(
                            tasks, return_when=asyncio.FIRST_COMPLETED
                        )
                        for p in pending:
                            p.cancel()
                        for d in done:
                            exc = d.exception()
                            if exc:
                                raise exc
                    finally:
                        for t in tasks:
                            t.cancel()

            except asyncio.CancelledError:
                readings.pop(dev_id, None)
                publish_now()
                raise
            except (
                NotTrustedError,
                PairingDialogResponsePendingError,
                UserDeniedPairingError,
                NotPairedError,
                PairingError,
            ):
                set_state("untrusted", False, None)
                await asyncio.sleep(2.0)
            except Exception:
                await asyncio.sleep(1.5)

    try:
        while True:
            usb_serials = await list_usb_serials(usbmux)

            for serial in list(workers.keys()):
                if serial not in usb_serials:
                    workers.pop(serial).cancel()

            for serial in usb_serials:
                task = workers.get(serial)
                if task is None or task.done():
                    workers[serial] = asyncio.create_task(monitor_device(serial))

            publish_now()
            await asyncio.sleep(1.5)
    finally:
        for task in workers.values():
            task.cancel()


def main() -> None:
    t = threading.Thread(target=watch_parent_stdin, daemon=True)
    t.start()
    try:
        asyncio.run(run_bridge())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
