import importlib.util
import pathlib
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location(
    "native_runtime", pathlib.Path(__file__).with_name("verify-android-native-runtime.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def elf(symbol, defined):
    names = b"\0" + symbol.encode() + b"\0"
    data = bytearray(304 + len(names))
    ident = b"\x7fELF\x02\x01\x01" + bytes(9)
    struct.pack_into("<16sHHIQQQIHHHHHH", data, 0, ident, 3, 183, 1, 0, 0, 64, 0,
                     64, 0, 0, 64, 3, 0)
    struct.pack_into("<IIQQQQIIQQ", data, 128, 0, 11, 0, 0, 256, 48, 2, 0, 8, 24)
    struct.pack_into("<IIQQQQIIQQ", data, 192, 0, 3, 0, 0, 304, len(names), 0, 0, 1, 0)
    struct.pack_into("<IBBHQQ", data, 280, 1, 0x12, 0, int(defined), 0, 0)
    data[304:] = names
    return bytes(data)


class NativeRuntimeTest(unittest.TestCase):
    def check_runtime(self, runtime_symbol, defined):
        with tempfile.TemporaryDirectory() as directory:
            apk = pathlib.Path(directory) / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("lib/arm64-v8a/libfbjni.so",
                                 elf("__cxa_init_primary_exception", False))
                archive.writestr("lib/arm64-v8a/libc++_shared.so",
                                 elf(runtime_symbol, defined))
            module.verify(apk)

    def test_exported_runtime_symbol_satisfies_fbjni(self):
        self.check_runtime("__cxa_init_primary_exception", True)

    def test_absent_runtime_symbol_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing __cxa_init_primary_exception"):
            self.check_runtime("older_runtime_symbol", True)

    def test_undefined_symbol_cannot_satisfy_the_dependency(self):
        with self.assertRaisesRegex(ValueError, "missing __cxa_init_primary_exception"):
            self.check_runtime("__cxa_init_primary_exception", False)


if __name__ == "__main__":
    unittest.main()
