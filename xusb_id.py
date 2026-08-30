#!/usr/bin/env python3

"""Query the USB device for the XUSB ID.

This is a MS-specific request to the device, which returns a 4-byte ID.
It is documented here: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-xusbi/4a51d209-016b-4221-a6b6-412ea33781af
We send a 2.2.8.5 Get_Device_ID to the device.

Run: sudo python3 xusb_id.py   (or ensure write access to /dev/bus/usb/...)
"""

import ctypes
import fcntl
import os
import glob
import struct
import sys
import getopt
import errno
import json
from typing import NamedTuple
from typing import List

# _IOWR('U', 0, struct usbdevfs_ctrltransfer) on x86-64
USBDEVFS_CONTROL = 0xC0185500


class UsbDevice(NamedTuple):
    bus_num: str
    dev_num: str
    serial: str


def find_devices(vid, expected_pid) -> List[UsbDevice]:
    devs = []
    for d in glob.glob("/sys/bus/usb/devices/*"):
        try:
            if open(d + "/idVendor").read().strip() == vid:
                pid = open(d + "/idProduct").read().strip()

                if expected_pid != pid:
                    continue

                try:
                    serial = open(d + "/serial").read().strip()
                except Exception:
                    serial = "?"
                bus = int(open(d + "/busnum").read())
                dev = int(open(d + "/devnum").read())

                device = UsbDevice(bus, dev, serial)
                devs.append(device)
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
        ctrl = (
            struct.pack("<BBHHHI", 0xC0, 0x01, 0x0000, 0x0000, 4, 1000)
            + b"\0" * 4
            + struct.pack("<Q", ctypes.addressof(buf))
        )
        fcntl.ioctl(fd, USBDEVFS_CONTROL, ctrl)
        return bytes(buf)
    finally:
        os.close(fd)


try:
    opts, args = getopt.getopt(sys.argv[1:], "hv:p:", ["help", "vid=", "pid=", "json"])
except getopt.GetoptError as err:
    print(err)
    sys.exit(2)


def print_help(exit_code, error_msg):
    print(f"Error: {error_msg}\n")
    print("""Usage: xusb_id.py [options]

Enumerates USB devices looking for the specific VID/PID combination.
If found, it queries the device for its XUSB ID and prints it out.

Options:
    -h, --help      Print this help message and exit
    -v, --vid       The USB VID to look for
    -p, --pid       The USB PID to look for
    --json          Print the output as JSON""")
    sys.exit(exit_code)


vid = None
pid = None
print_json = False

for opt, arg in opts:
    if opt in ("-h", "--help"):
        print_help(0)
    elif opt in ("-v", "--vid"):
        vid = arg
    elif opt in ("-p", "--pid"):
        pid = arg
    elif opt in ("--json"):
        print_json = True

if not vid or not pid:
    print_help(1, "Missing VID or PID")

devs = find_devices(vid, pid)
if not devs:
    print("no 2dc8 devices found")
    sys.exit(1)

json_out = []
for device in devs:
    bus = device.bus_num
    dev = device.dev_num
    serial = device.serial

    try:
        xid = get_xusb_id(bus, dev)
        if print_json:
            dict = device._asdict()
            dict["xid"] = xid.hex()
            json_out.append(dict)
        else:
            print(f"Found device with xid: {bus:03d}:{dev:03d}")
            print(f"serial  = {serial:12}")
            print(f"xid     = {xid.hex()}")
            print()
    except OSError as e:
        if e.errno == errno.EPIPE:
            note = "STALL - device rejected the request"
        else:
            note = f"failed: {e}"
        print(
            f"Failed to get xid for device {bus:03d}:{dev:03d} serial={serial:12}:",
            file=sys.stderr,
        )
        print(note, file=sys.stderr)
        sys.exit(1)

if print_json:
    print(json.dumps(json_out, indent=2))
