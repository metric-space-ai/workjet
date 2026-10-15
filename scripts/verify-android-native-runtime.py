"""Check the packaged ARM64 C++ runtime against fbjni's required ABI."""
import argparse
import struct
import zipfile


def dynamic_symbols(data):
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Expected ELF64 little-endian native library")
    if struct.unpack_from("<H", data, 18)[0] != 183:
        raise ValueError("Expected AArch64 native library")
    offset = struct.unpack_from("<Q", data, 40)[0]
    stride, count = struct.unpack_from("<HH", data, 58)
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, offset + i * stride) for i in range(count)]
    symbols = {}
    for section in sections:
        if section[1] != 11:  # SHT_DYNSYM
            continue
        strings = sections[section[6]]
        names = data[strings[4]:strings[4] + strings[5]]
        for pos in range(section[4], section[4] + section[5], section[9]):
            name, info, _, index, _, _ = struct.unpack_from("<IBBHQQ", data, pos)
            end = names.find(b"\0", name)
            if end >= 0:
                symbols[names[name:end].decode()] = index != 0 and info >> 4 in (1, 2)
    return symbols


def verify(apk):
    with zipfile.ZipFile(apk) as archive:
        prefix = "lib/arm64-v8a/"
        fbjni = dynamic_symbols(archive.read(prefix + "libfbjni.so"))
        runtime = dynamic_symbols(archive.read(prefix + "libc++_shared.so"))
    symbol = "__cxa_init_primary_exception"
    if symbol in fbjni and not runtime.get(symbol, False):
        raise ValueError(f"Packaged libc++_shared.so cannot satisfy fbjni: missing {symbol}")
    print("ARM64 fbjni / libc++ runtime ABI verified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk")
    verify(parser.parse_args().apk)
