#!/usr/bin/env python3
"""Test the confirm-dialog guard's call pattern and its two skip rules.

The guard is the only thing that keeps native browser dialogs out of the web
app, and its pattern is delicate. The comment-skipping rule exists because the
pattern matched this repo's own prose: a doc comment reading "the refute-reason
prompt (r)" satisfies the word "prompt" followed by an opening parenthesis. An
edit that narrows the call pattern, or that widens the comment rule until it
swallows a line with code before a trailing comment, would leave the guard
printing "ok" over a tree that breaks the rule, and nothing would fail. These
tests pin both edges.

`scan` takes the root to walk, so every case builds a small tree in a temporary
directory. Nothing here reads the repo's own web tree.

Usage:
    python3 scripts/ci/confirm_dialog_guard_test.py
"""
from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import confirm_dialog_guard as guard  # noqa: E402  (needs the path above)


class GuardTest(unittest.TestCase):
    """Each case writes a tree, scans it, and asserts on what came back."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def write(self, files: dict[str, str]) -> None:
        for rel, text in files.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def hits(self, files: dict[str, str]) -> list[str]:
        """Write `files` under the temp root and return the reported source text.

        A report is `path:line: text`; the path is a temp directory that says
        nothing, so the assertions read the text.
        """
        self.write(files)
        return [report.split(": ", 1)[1] for report in guard.scan(self.root)]

    # --- the call pattern catches every native dialog ---------------------

    def test_bare_confirm_is_caught(self) -> None:
        self.assertEqual(
            self.hits({"a.tsx": 'if (confirm("Delete?")) remove();\n'}),
            ['if (confirm("Delete?")) remove();'],
        )

    def test_window_confirm_is_caught(self) -> None:
        self.assertEqual(
            self.hits({"a.tsx": 'if (window.confirm("Delete?")) remove();\n'}),
            ['if (window.confirm("Delete?")) remove();'],
        )

    def test_global_this_confirm_is_caught(self) -> None:
        self.assertEqual(
            self.hits({"a.ts": 'globalThis.confirm("Delete?");\n'}),
            ['globalThis.confirm("Delete?");'],
        )

    def test_self_confirm_is_caught(self) -> None:
        """`self` is the third global spelling the pattern names."""
        self.assertEqual(
            self.hits({"a.ts": 'self.confirm("Delete?");\n'}),
            ['self.confirm("Delete?");'],
        )

    def test_alert_is_caught(self) -> None:
        self.assertEqual(
            self.hits({"a.tsx": 'alert("Saved");\n'}),
            ['alert("Saved");'],
        )

    def test_prompt_is_caught(self) -> None:
        self.assertEqual(
            self.hits({"a.tsx": 'const name = prompt("New name?");\n'}),
            ['const name = prompt("New name?");'],
        )

    def test_whitespace_between_global_and_call_is_caught(self) -> None:
        """Formatting must not be an escape hatch."""
        self.assertEqual(
            self.hits({"a.ts": "window . confirm ();\n"}),
            ["window . confirm ();"],
        )

    def test_every_source_suffix_is_scanned(self) -> None:
        files = {
            "a.ts": "confirm();\n",
            "b.tsx": "confirm();\n",
            "c.js": "confirm();\n",
            "d.jsx": "confirm();\n",
        }
        self.assertEqual(len(self.hits(files)), 4)

    def test_a_report_names_the_file_and_line(self) -> None:
        """The report must locate the call, not just count it."""
        self.write({"deep/nested/a.tsx": "const x = 1;\n\nconfirm();\n"})
        reports = guard.scan(self.root)
        self.assertEqual(len(reports), 1)
        self.assertTrue(reports[0].endswith("deep/nested/a.tsx:3: confirm();"))

    # --- prose is not a call ----------------------------------------------

    def test_doc_comment_prose_is_not_caught(self) -> None:
        """The exact prose that made this skip rule necessary.

        Copied from packages/web/src/components/security/findings-review.tsx.
        """
        source = (
            "/** The refute-reason prompt (`r` and the Refute button). The route requires\n"
            " * a reason naming what the evidence missed. */\n"
            "function RefuteDialog() {}\n"
        )
        self.assertEqual(self.hits({"a.tsx": source}), [])

    def test_line_comment_prose_is_not_caught(self) -> None:
        source = (
            "// The confirm (yes/no) step runs before the mutation.\n"
            "  // An indented note about the alert (banner) copy.\n"
            "const x = 1;\n"
        )
        self.assertEqual(self.hits({"a.ts": source}), [])

    def test_block_comment_opener_is_not_caught(self) -> None:
        source = "/* the prompt (r) shortcut */\nconst x = 1;\n"
        self.assertEqual(self.hits({"a.ts": source}), [])

    # --- but a comment must not shelter code ------------------------------

    def test_trailing_comment_after_code_is_still_scanned(self) -> None:
        """Erring toward a report is safe here; erring toward silence is not."""
        self.assertEqual(
            self.hits({"a.tsx": "remove(); // confirm() used to guard this\n"}),
            ["remove(); // confirm() used to guard this"],
        )

    # --- an identifier that merely ends in the word is not a call ---------

    def test_identifier_ending_in_the_word_is_not_caught(self) -> None:
        source = (
            "setConfirm(true);\n"
            "const [open, setConfirm] = useState(false);\n"
            "onConfirm(next);\n"
            "reconfirm(choice);\n"
        )
        self.assertEqual(self.hits({"a.tsx": source}), [])

    def test_method_on_another_object_is_not_caught(self) -> None:
        source = "dialog.confirm();\nthis.confirm();\ninquirer.prompt(questions);\n"
        self.assertEqual(self.hits({"a.ts": source}), [])

    # --- exemptions --------------------------------------------------------

    def test_test_files_are_exempt(self) -> None:
        """A test stubs the global or asserts on the old behavior."""
        files = {
            "a.test.ts": "confirm();\n",
            "b.test.tsx": "window.confirm();\n",
            "c.test.js": "alert();\n",
            "d.test.jsx": "prompt();\n",
        }
        self.assertEqual(self.hits(files), [])

    def test_the_primitive_itself_is_exempt(self) -> None:
        """Its doc comment names the confirm() call it replaces."""
        source = "// Replaces confirm(); see the guard.\nexport function ConfirmDialog() {}\n"
        rel = "components/primitives/confirm-dialog.tsx"
        self.assertEqual(self.hits({rel: source}), [])

    def test_a_different_confirm_dialog_file_is_not_exempt(self) -> None:
        """The exemption is that one path, not any file with that name."""
        rel = "components/session/confirm-dialog.tsx"
        self.assertEqual(self.hits({rel: "confirm();\n"}), ["confirm();"])

    def test_non_source_files_are_ignored(self) -> None:
        files = {"a.md": "confirm();\n", "b.css": "confirm();\n", "c.json": "confirm();\n"}
        self.assertEqual(self.hits(files), [])

    def test_a_clean_tree_reports_nothing(self) -> None:
        """The replacement the guard steers people toward must stay clean."""
        source = (
            "export function Panel() {\n"
            "  return <ConfirmDialog open={open} onConfirm={remove} pending={pending} />;\n"
            "}\n"
        )
        self.assertEqual(self.hits({"a.tsx": source}), [])

    # --- the guard must never pass by scanning nothing --------------------

    def test_a_missing_web_tree_fails(self) -> None:
        """A moved tree must fail loudly, not report ok over zero files."""
        stderr = io.StringIO()
        with mock.patch.object(guard, "WEB", self.root / "gone"):
            with contextlib.redirect_stderr(stderr):
                code = guard.main()
        self.assertEqual(code, 1)
        self.assertIn("Update WEB in", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
