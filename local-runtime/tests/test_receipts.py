from core.receipts import LocalExecutionReceipt, content_hash


def test_receipt_binds_task_and_content_hashes() -> None:
    receipt = LocalExecutionReceipt(
        "run-1",
        "task-1",
        "echo",
        "allow",
        "completed",
        content_hash({"x": 1}),
        content_hash({"x": 1}),
    )

    assert receipt.as_dict()["task_id"] == "task-1"
    assert receipt.result_hash == receipt.payload_hash
