import getopt
import struct
import sys
import zlib
from typing import NamedTuple

# The stock XUSB ID reported by the Ultimate 2C controller
STOCK_ID = bytes.fromhex("52180684")


class FirmwareUpdate(NamedTuple):
    version: int
    flash_dst: int
    payload_size: int
    product_id: int
    payload: bytearray

    def crc32(self):
        return zlib.crc32(self.payload)

    def locate_xid(self, expected_id=STOCK_ID):
        hits = []
        pos = 0
        while True:
            pos = self.payload.find(expected_id, pos)
            if pos < 0:
                break
            hits.append(pos)
            pos += 1

        if len(hits) == 0:
            raise Exception(
                f"Could not find XUSB ID {expected_id.hex()} in firmware update."
            )

        if len(hits) > 1:
            raise Exception(
                f"Found more than one XUSB ID {expected_id.hex()} in firmware update."
            )

        return hits[0]

    def locate_stuffing(self):
        for i in range(len(self.payload) - 1, -1, -1):
            if self.payload[i] != 0:
                return i - 3

        return -1

    def solve_crc32(self):
        pos = self.locate_stuffing()
        if pos < 0:
            raise Exception("Could not find stuffing in firmware update.")

        # CRC32 is hash over over GF(2), flipping patch bit i changes the final CRC by a fixed amount.
        # Solved by Gaussian elimination of a 32x32 linear system.
        self.payload[pos : pos + 4] = b"\0\0\0\0"
        c0 = zlib.crc32(bytes(self.payload)) & 0xFFFFFFFF
        cols = []
        for i in range(32):
            self.payload[pos + i // 8] = 1 << (i % 8)
            cols.append((zlib.crc32(bytes(self.payload)) & 0xFFFFFFFF) ^ c0)
            self.payload[pos + i // 8] = 0

        rhs = c0 ^ 0xFFFFFFFF
        rows = []
        for e in range(32):  # one equation per output bit
            mask = 0
            for i in range(32):
                if (cols[i] >> e) & 1:
                    mask |= 1 << i
            rows.append([mask, (rhs >> e) & 1])

        for col in range(32):  # eliminate to reduced row echelon
            pivot = None
            for r in range(col, 32):
                if (rows[r][0] >> col) & 1:
                    pivot = r
                    break

            rows[col], rows[pivot] = rows[pivot], rows[col]
            for r in range(32):
                if r != col and (rows[r][0] >> col) & 1:
                    rows[r][0] ^= rows[col][0]
                    rows[r][1] ^= rows[col][1]

        x = 0
        for col in range(32):
            if rows[col][1]:
                x |= 1 << col

        self.payload[pos : pos + 4] = x.to_bytes(4, "little")

    def patch_xid(self, new_xid):
        pos = self.locate_xid()
        self.payload[pos : pos + 4] = new_xid

    @staticmethod
    def parse_controller_firmware_update(data):
        # Parse the fixed header, see the included hexpat file.
        header = struct.unpack("<B xxx L L H xx L xxxxxxxx", data[:28])
        version, flash_dst, payload_size, product_id, unknown1 = header

        # Extract the payload
        payload = bytearray(data[28 : 28 + payload_size])

        return FirmwareUpdate(
            version=version,
            flash_dst=flash_dst,
            payload_size=payload_size,
            product_id=product_id,
            payload=payload,
        )


def print_help(exit_code, error_msg=None):
    if error_msg:
        print(f"Error: {error_msg}\n")
    print("""Usage: xusb_id_patcher.py <command> [options]

Commands:
    show <filename>            Read a firmware update file and print its details
    patch <filename>           Patch the XUSB ID in a firmware update file

Options:
    -h, --help          Print this help message and exit
    -x, --xid <xid>     The XUSB ID to look for (hex, show), or write (patch)
    -o, --output <file> Output filename to write the patched file to (patch)""")
    sys.exit(exit_code)


def load_update(filename):
    with open(filename, "rb") as file:
        data = file.read()
    return FirmwareUpdate.parse_controller_firmware_update(data)


def cmd_show(filename, expected_xid=None):
    if expected_xid is not None:
        expected_id = bytes.fromhex(expected_xid)
    else:
        expected_id = STOCK_ID
    update = load_update(filename)
    print(f"Version: {update.version}")
    print(f"    PID: 0x{update.product_id:x}")
    print(f"    CRC: 0x{update.crc32():x}")
    print(
        f"    XID ({expected_id.hex()}) at offset: 0x{update.locate_xid(expected_id):x}"
    )
    stuffing = update.locate_stuffing()
    print(f"    Stuffing: 0x{stuffing:x}")
    return update


def cmd_patch(filename, new_xid, output):
    with open(filename, "rb") as file:
        header = file.read(28)
    update = load_update(filename)

    pos = update.locate_xid()
    old_xid = bytes(update.payload[pos : pos + 4])

    print(f"Patching XID from {old_xid.hex()} to {new_xid}")
    update.patch_xid(bytes.fromhex(new_xid))
    update.solve_crc32()
    print(f"    CRC: 0x{update.crc32():x}")

    with open(output, "wb") as file:
        file.write(header + bytes(update.payload))
    return update


def main(argv):
    try:
        opts, args = getopt.gnu_getopt(argv, "hx:o:", ["help", "xid=", "output="])
    except getopt.GetoptError as err:
        print_help(2, str(err))

    new_xid = None
    output = None

    for opt, arg in opts:
        if opt in ("-h", "--help"):
            print_help(0)
        elif opt in ("-x", "--xid"):
            new_xid = arg
        elif opt in ("-o", "--output"):
            output = arg

    if len(args) == 0:
        print_help(1, "Missing command")
    command = args[0]

    if command == "show":
        if len(args) != 2:
            print_help(1, "show takes exactly one filename")
        cmd_show(args[1], new_xid)
    elif command == "patch":
        if len(args) != 2:
            print_help(1, "patch takes exactly one filename")
        if new_xid is None:
            print_help(1, "patch requires --xid")
        if output is None:
            print_help(1, "patch requires --output")
        cmd_patch(args[1], new_xid, output)
    else:
        print_help(1, f"Unknown command: {command}")


if __name__ == "__main__":
    main(sys.argv[1:])
