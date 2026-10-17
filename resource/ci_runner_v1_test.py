"""Supervisor/gate fixtures only. Real C evidence is produced by the Linux lane."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import ci_runner_v1 as runner


class RunnerTests(unittest.TestCase):
    def setUp(self):
        evidence = os.environ.get("RESOURCE_SUPERVISOR_EVIDENCE")
        self.temp = None
        if evidence:
            self.root = Path(evidence) / self._testMethodName
            self.root.mkdir(mode=0o700)
        else:
            self.temp = tempfile.TemporaryDirectory(prefix="resource-ci-supervisor-")
            self.root = Path(self.temp.name)

    def tearDown(self):
        if self.temp:
            self.temp.cleanup()  # Only this test's freshly created temporary directory.

    def output(self, name):
        path = self.root / name
        path.mkdir(mode=0o700)
        return path

    def fake_compiler(self, compile_exit=0, test_exit=0):
        path = self.root / "fixture-compiler"
        code = ("#!" + sys.executable + "\nimport sys\nfrom pathlib import Path\n"
                + "sys.exit(" + str(compile_exit) + ")\n" if compile_exit else
                "#!" + sys.executable + "\nimport sys\nfrom pathlib import Path\n"
                + "p=Path(sys.argv[sys.argv.index('-o')+1])\n"
                + "p.write_text(" + repr("#!" + sys.executable + "\nimport sys\nsys.exit(" + str(test_exit) + ")\n") + ")\n"
                + "p.chmod(0o700)\n")
        path.write_text(code)
        path.chmod(0o700)
        return str(path)

    def test_success_and_two_eof(self):
        out = self.output("success")
        runner.compile_and_test(self.fake_compiler(), self.root, out)
        for phase in ["compile", "test"]:
            result = json.loads((out / (phase + ".result.json")).read_bytes())
            self.assertTrue(result["passed"])
            self.assertTrue(result["waitCompleted"])
            self.assertEqual(result["EOF"], {"stdout": True, "stderr": True})

    def test_compile_failure_propagates_without_test(self):
        out = self.output("compile-fail")
        with self.assertRaisesRegex(RuntimeError, "compile did not pass"):
            runner.compile_and_test(self.fake_compiler(compile_exit=7), self.root, out)
        self.assertEqual(json.loads((out / "compile.result.json").read_bytes())["exitCode"], 7)
        self.assertFalse((out / "test.plan.json").exists())

    def test_test_failure_propagates(self):
        out = self.output("test-fail")
        with self.assertRaisesRegex(RuntimeError, "test did not pass"):
            runner.compile_and_test(self.fake_compiler(test_exit=9), self.root, out)
        self.assertEqual(json.loads((out / "test.result.json").read_bytes())["exitCode"], 9)

    def test_timeout_is_not_pass(self):
        out = self.output("timeout")
        result = runner.run_child([sys.executable, "-c", "import time; time.sleep(10)"],
                                  self.root, out, "sleep", seconds=0.05, grace=0.05)
        self.assertTrue(result["timeout"])
        self.assertFalse(result["passed"])
        self.assertTrue(result["waitCompleted"])
        self.assertTrue(all(result["EOF"].values()))

    def test_stdout_cap_is_not_pass(self):
        out = self.output("overflow")
        result = runner.run_child([sys.executable, "-c", "import os; os.write(1,b'x'*1100000)"],
                                  self.root, out, "overflow", grace=0.05)
        self.assertTrue(result["overflow"])
        self.assertFalse(result["passed"])
        self.assertEqual(result["streams"]["stdout"]["bytes"], 1048576)

    def test_combined_cap_is_not_pass(self):
        out = self.output("combined")
        result = runner.run_child([sys.executable, "-c",
                                  "import os; os.write(1,b'x'*1048576); os.write(2,b'y'*1100000)"],
                                  self.root, out, "combined", grace=0.05)
        self.assertTrue(result["overflow"])
        self.assertFalse(result["passed"])
        self.assertEqual(sum(v["bytes"] for v in result["streams"].values()), 2097152)

    def test_required_gate_all_results(self):
        for lane in ["success", "failure", "cancelled", "skipped", "", "unknown"]:
            self.assertEqual(runner.gate("full", lane), lane == "success")
            self.assertEqual(runner.gate("docs", lane), lane == "skipped")
            self.assertFalse(runner.gate("", lane))
            self.assertFalse(runner.gate("unknown", lane))

    def test_missing_executable_does_not_pass(self):
        with self.assertRaises(FileNotFoundError):
            runner.compile_and_test(str(self.root / "missing-compiler"), self.root, self.output("missing-output"))

    def test_required_gate_cli_exit_propagation(self):
        for index, (mode, lane, expected) in enumerate([
                ("full", "success", 0), ("full", "failure", 1),
                ("full", "cancelled", 1), ("full", "skipped", 1),
                ("docs", "skipped", 0), ("docs", "success", 1), ("", "success", 1)]):
            out = self.output("gate-" + str(index))
            result = runner.run_child([sys.executable, "-B", runner.__file__, "gate",
                                       "--mode", mode, "--lane", lane], self.root, out, "gate")
            self.assertEqual(result["exitCode"], expected)
            self.assertTrue(result["waitCompleted"])
            self.assertTrue(all(result["EOF"].values()))

    def test_cannot_overwrite_old_raw(self):
        out = self.output("exclusive")
        path = out / "old"
        runner.save(path, b"first failure")
        with self.assertRaises(FileExistsError):
            runner.save(path, b"green")
        self.assertEqual(path.read_bytes(), b"first failure")

    def executable_fixture(self, name, stdout):
        path = self.root / name
        path.write_text("#!" + sys.executable + "\nprint(" + repr(stdout) + ")\n")
        path.chmod(0o700)
        return str(path)

    def test_driver_selected_linker_identity(self):
        linker = self.executable_fixture("fixture-ld", "fixture linker, not Linux evidence")
        compiler = self.executable_fixture("fixture-cc-query", linker)
        proof = runner.selected_linker(compiler, self.root, self.output("linker-proof"))
        self.assertEqual(proof["identity"], runner.identity(linker))

    def test_elf_runtime_parser_file_identities(self):
        binary = self.root / "fixture-elf-not-executed"
        binary.write_bytes(b"not a real ELF: parser fixtures only")
        loader = self.root / "fixture-loader"
        libc = self.root / "fixture-libc"
        loader.write_bytes(b"loader fixture")
        libc.write_bytes(b"libc fixture")
        readelf = self.executable_fixture("fixture-readelf", "[Requesting program interpreter: " + str(loader) + "]")
        ldd = self.executable_fixture("fixture-ldd", "linux-vdso.so.1 (0x123)\nlibc.so.6 => " + str(libc) + " (0x456)\n" + str(loader) + " (0x789)")
        with mock.patch.object(runner.shutil, "which", side_effect=lambda name, **_: {"readelf": readelf, "ldd": ldd}[name]):
            proof = runner.elf_runtime(binary, self.root, self.output("runtime-proof"))
        self.assertEqual(proof["interpreter"], runner.identity(loader))
        self.assertEqual(proof["dependencies"][1]["identity"], runner.identity(libc))
        self.assertIsNone(proof["dependencies"][0]["diskIdentity"])

    def test_missing_runtime_tools_are_unknown_and_fail(self):
        binary = self.root / "fixture-binary"
        binary.write_bytes(b"fixture")
        out = self.output("runtime-unknown")
        with mock.patch.object(runner.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "UNKNOWN"):
                runner.elf_runtime(binary, self.root, out)
        self.assertEqual(json.loads((out / "runtime-identity.json").read_bytes())["status"], "UNKNOWN")


if __name__ == "__main__":
    os.umask(0o077)
    evidence = os.environ.get("RESOURCE_SUPERVISOR_EVIDENCE")
    if evidence:
        path = Path(evidence)
        if not path.is_absolute():
            raise ValueError("supervisor evidence requires an absolute new root")
        path.mkdir(mode=0o700)
    unittest.main()
