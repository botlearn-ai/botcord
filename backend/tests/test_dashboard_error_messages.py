from hub.routers.dashboard import _extract_text_from_envelope


def test_dashboard_extracts_error_payload_message_as_text():
    sender_id, text, payload = _extract_text_from_envelope(
        {
            "from": "ag_runtime",
            "type": "error",
            "payload": {
                "error": {
                    "code": "agent_error",
                    "message": "Runtime error: missing API key",
                }
            },
        }
    )

    assert sender_id == "ag_runtime"
    assert text == "Runtime error: missing API key"
    assert payload["error"]["code"] == "agent_error"


def test_dashboard_error_text_falls_back_to_code():
    _, text, _ = _extract_text_from_envelope(
        {
            "from": "ag_runtime",
            "type": "error",
            "payload": {"error": {"code": "agent_error"}},
        }
    )

    assert text == "agent_error"
