#!/usr/bin/env python3
"""Query the MS-XUSBI 2.2.8.5 device-ID vendor request from all attached
8BitDo devices (VID 0x2DC8): bmRequestType=0xC0 bRequest=0x01 wValue=0 wIndex=0 wLength=4.
Run:  sudo python3 xusb_id.py   (or ensure write access to /dev/bus/usb/...)
"""
import ctypes, fcntl, os, glob, struct, sys

USBDEVFS_CONTROL = 0xC0185500  # _IOWR('U', 0, struct usbdevfs_ctrltransfer) on x86-64

def find_devices(vid="2dc8"):
    devs = []
    for d in glob.glob("/sys/bus/usb/devices/*"):
        try:
            if open(d + "/idVendor").read().strip() == vid:
                bus = int(open(d + "/busnum").read())
                dev = int(open(d + "/devnum").read())
                pid = open(d + "/idProduct").read().strip()
                try:
                    serial = open(d + "/serial").read().strip()
                except Exception:
                    serial = "?"
                devs.append((bus, dev, pid, serial))
        except Exception:
            pass
    return devs

def get_xusb_id(bus, dev):
    path = f"/dev/bus/usb/{bus:03d}/{dev:03d}"
    fd = os.open(path, os.O_RDWR)
    try:
        buf = ctypes.create_string_buffer(4)
        # struct usbdevfs_ctrltransfer: u8 reqtype, u8 req, u16 val, u16 idx,
        #                               u16 len, u32 timeout, (pad), void *data
        ctrl = (struct.pack("<BBHHHI", 0xC0, 0x01, 0x0000, 0x0000, 4, 1000)
                + b"\0" * 4
                + struct.pack("<Q", ctypes.addressof(buf)))
        fcntl.ioctl(fd, USBDEVFS_CONTROL, ctrl)
        return bytes(buf)
    finally:
        os.close(fd)

devs = find_devices()
if not devs:
    print("no 2dc8 devices found"); sys.exit(1)
for bus, dev, pid, serial in devs:
    try:
        rid = get_xusb_id(bus, dev)
        print(f"bus {bus:03d} dev {dev:03d}  pid 0x{pid}  serial {serial:12}  XUSB ID: {rid.hex()}  ({int.from_bytes(rid,'little')})")
    except OSError as e:
        import errno
        if e.errno == errno.EPIPE:
            note = "STALL - device rejected the request (not implemented in this mode?)"
        else:
            note = f"failed: {e}"
        print(f"bus {bus:03d} dev {dev:03d}  pid 0x{pid}  serial {serial:12}  {note}")
