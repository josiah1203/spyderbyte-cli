from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATES = ROOT / "docs/spyderbyte-integration/RELEASE_GATES.md"
EVIDENCE = ROOT / "docs/spyderbyte-integration/WAVE_7_EVIDENCE.md"


def test_release_gates_document_blocked_section_13_work() -> None:
    text = GATES.read_text(encoding="utf-8")
    for token in ("H3", "H4", "H5", "H6", "P5", "P6", "Q8", "U6", "Blocked"):
        assert token in text
    assert "Section 13" in text


def test_wave_7_evidence_does_not_claim_hosted_completion() -> None:
    text = EVIDENCE.read_text(encoding="utf-8")
    assert "Blocked" in text
    assert "Complete locally for scaffolding" in text or "scaffolding" in text.lower()
    assert "signed" in text.lower()
