"""A tiny shopping cart."""


def subtotal(items):
    """The price of everything in the cart: (price, quantity) pairs."""
    return sum(price * qty for price, qty in items)


def total(items, discount=0.0):
    """The subtotal with a discount (0.1 = 10 % off), rounded to cents."""
    return round(subtotal(items) * discount, 2)
