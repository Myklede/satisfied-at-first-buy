"""Enumerate Windows camera names/links without opening a capture stream."""

from __future__ import annotations

import ctypes as c
import json
import uuid


def guid(value: str) -> c.Array:
    return (c.c_ubyte * 16).from_buffer_copy(uuid.UUID(value).bytes_le)


def call(obj: c.c_void_p, slot: int, *types: type):
    table = c.cast(obj, c.POINTER(c.POINTER(c.c_void_p))).contents
    return c.WINFUNCTYPE(c.c_long, c.c_void_p, *types)(table[slot])


def release(obj: c.c_void_p) -> None:
    if obj:
        call(obj, 2)(obj)


def check(hr: int) -> None:
    if hr < 0:
        raise OSError(f"HRESULT {hr & 0xFFFFFFFF:08x}")


def mf_devices() -> list[dict]:
    mf = c.WinDLL("mfplat")
    source = c.WinDLL("mf")
    check(mf.MFStartup(0x20070, 0))
    attr = c.c_void_p()
    devices = c.POINTER(c.c_void_p)()
    count = c.c_uint()
    try:
        check(mf.MFCreateAttributes(c.byref(attr), 1))
        check(
            call(attr, 24, c.c_void_p, c.c_void_p)(
                attr,
                guid("c60ac5fe-252a-478f-a0ef-bc8fa5f7cad3"),
                guid("8ac3587a-4ae7-42d8-99e0-0a6013eef90f"),
            )
        )
        check(source.MFEnumDeviceSources(attr, c.byref(devices), c.byref(count)))
        rows = []
        for i in range(count.value):
            obj = c.c_void_p(devices[i])
            row = {"index": i}
            try:
                for key, gid in [
                    ("name", "60d0e559-52f8-4fa2-bbce-acdb34a8ec01"),
                    ("link", "58f0aad8-22bf-4f8a-bb3d-d2c4978c6e2f"),
                ]:
                    text = c.c_void_p()
                    length = c.c_uint()
                    check(
                        call(obj, 13, c.c_void_p, c.c_void_p, c.c_void_p)(
                            obj, guid(gid), c.byref(text), c.byref(length)
                        )
                    )
                    row[key] = c.wstring_at(text, length.value)
                    c.windll.ole32.CoTaskMemFree(text)
                rows.append(row)
            finally:
                release(obj)
        return rows
    finally:
        if devices:
            c.windll.ole32.CoTaskMemFree(devices)
        release(attr)
        mf.MFShutdown()


def dshow_devices() -> list[dict]:
    dev = c.c_void_p()
    enumerator = c.c_void_p()
    check(
        c.windll.ole32.CoCreateInstance(
            guid("62be5d10-60eb-11d0-bd3b-00a0c911ce86"),
            None,
            1,
            guid("29840822-5b84-11d0-bd3b-00a0c911ce86"),
            c.byref(dev),
        )
    )
    rows = []
    try:
        check(
            call(dev, 3, c.c_void_p, c.c_void_p, c.c_uint)(
                dev, guid("860bb310-5d01-11d0-bd3b-00a0c911ce86"), c.byref(enumerator), 0
            )
        )
        if not enumerator:
            return rows
        while True:
            moniker, bag = c.c_void_p(), c.c_void_p()
            if (
                call(enumerator, 3, c.c_uint, c.c_void_p, c.c_void_p)(
                    enumerator, 1, c.byref(moniker), None
                )
                != 0
            ):
                break
            try:
                check(
                    call(moniker, 9, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p)(
                        moniker,
                        None,
                        None,
                        guid("55272a00-42cb-11ce-8135-00aa004bb851"),
                        c.byref(bag),
                    )
                )
                row = {"index": len(rows)}
                for prop in ["FriendlyName", "DevicePath"]:
                    variant = c.create_string_buffer(24)
                    hr = call(bag, 3, c.c_wchar_p, c.c_void_p, c.c_void_p)(bag, prop, variant, None)
                    if hr >= 0 and c.c_ushort.from_buffer(variant).value == 8:
                        row[prop] = c.wstring_at(c.c_void_p.from_buffer(variant, 8).value)
                    c.windll.oleaut32.VariantClear(variant)
                rows.append(row)
            finally:
                release(bag)
                release(moniker)
        return rows
    finally:
        release(enumerator)
        release(dev)


if __name__ == "__main__":
    check(c.windll.ole32.CoInitializeEx(None, 2))
    try:
        print(json.dumps({"MSMF": mf_devices(), "DSHOW": dshow_devices()}))
    finally:
        c.windll.ole32.CoUninitialize()
