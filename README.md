# Bytedo Controller Enhancement

Tools for patching the XUSB ID of the 8BitDo Ultimate 2C controller and their USB receivers.

You probably want to use the [browser version](https://ripdajacker.github.io/bytedo-patcher/) of the tool.

The tool consists of two scripts:

- `xusb_id.py` lets you send the XUSB ID request to the controller.
- `xusb_id_patcher.py` lets you patch the XUSB ID of the stock controller and dongle firmware.

Both have a web version so you can do the stuff in the browser.

I have no affiliation with 8BitDo, this is just a personal project to fix an issue I had on my Xbox 360.

## Why

I have an Xbox 360 that has been patched to allow non-MS controllers and when connecting more
than one 8BitDo Ultimate 2C to the console, they are seen as one device, making it impossible
to have a two player couch co-op game.

The original hack was to monkey patch the kernel, which led to a very informative discussion
in the [PR#23 on UsbdSecPatch](https://github.com/InvoxiPlayGames/UsbdSecPatch/pull/23), which
in turn led me to reverse engineer the firmware for the controller and fix the XUSB ID bug in
a manner that lets other benefit from it.

## Requirements

The `xusb_id.py` script only runs on Linux and most likely requires root.

The `xusb_id_patcher.py` most likely runs fine on MacOS, WSL and maybe even on Windows

I did not manage to run the updater software in Wine, so I copied the files over to a
machine running Windows to do the actual update.

## How to patch/flash (latter only tested on Windows)

1. Download the 8BitDo updater app and update the firmware on your controller _and_ your dongle
2. If you run it as Administrator the firmware will be downloaded to `Config/updateFile`
3. Firmwares have long filenames that end in `.dat`
4. The files that are around 75kb are for the controller, the ones around 50kb are for the dongle
5. Go to [ripdajacker.github.io/bytedo-patcher](https://ripdajacker.github.io/bytedo-patcher/) and patch the file in your browser
6. Alternatively run  `xusb_id_patcher.py` and put in your desired XUSB ID. I used the first 4 bytes of the controller serial
7. Put the patched files back into `Config/updateFile`
8. Flash the controller and/or dongle
9. Enjoy multiplayer games on your Xbox 360

## xusb_id.py

Reads the XUSB ID directly from attached USB devices.

The XUSB ID is a 4-byte value returned by an MS-specific
[Get_Device_ID](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-xusbi/4a51d209-016b-4221-a6b6-412ea33781af)
request. Requires access to the device (e.g. `sudo` or write permission on
`/dev/bus/usb/...`).

```
sudo python3 xusb_id.py -v <vid> -p <pid>
sudo python3 xusb_id.py -v 2dc8 -p 301e --json
```

Options:

- `-v, --vid` — USB vendor ID to look for
- `-p, --pid` — USB product ID to look for
- `--json` — print results as JSON
- `-h, --help` — show help

## xusb_id_patcher.py

Inspects and patches the XUSB ID inside a controller firmware update `.dat`
file, fixing up the embedded CRC32 automatically.

```
python3 xusb_id_patcher.py show <file> [-x <expected_xid>]
python3 xusb_id_patcher.py patch <file> -x <new_xid> -o <output>
```

Commands:

- `show <file>` — print firmware version, PID, CRC, XID offset, and stuffing offset.
  `-x/--xid` sets the ID to look for (defaults to the stock ID, useful for
  inspecting already-patched files).
- `patch <file>` — rewrite the XID and fix the CRC. Requires `-x/--xid` (hex,
  e.g. `cafebabe`) and `-o/--output`.

Options:

- `-x, --xid <xid>` — ID to look for (`show`) or write (`patch`)
- `-o, --output <file>` — output file for `patch`
- `-h, --help` — show help

The patcher locates the 4-byte ID in the payload, overwrites it with the new
ID, then recomputes the firmware CRC by solving a linear system over GF(2) and
patching the stuffing bytes, so the result validates.

`8bitdo-firmwareupdate.hexpat` describes the firmware update header format for
use with [ImHex](https://imhex.werwolv.net/).
