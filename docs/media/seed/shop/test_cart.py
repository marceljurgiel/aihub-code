from cart import subtotal, total

ITEMS = [(2.50, 2), (4.00, 1)]


def test_subtotal():
    assert subtotal(ITEMS) == 9.00


def test_total_without_discount():
    assert total(ITEMS) == 9.00


def test_total_with_discount():
    assert total(ITEMS, 0.1) == 8.10
