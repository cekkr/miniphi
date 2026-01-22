import unittest
from solution import is_prime

class TestIsPrime(unittest.TestCase):
    def test_small(self):
        self.assertFalse(is_prime(0))
        self.assertFalse(is_prime(1))
        self.assertTrue(is_prime(2))
        self.assertTrue(is_prime(3))
        self.assertFalse(is_prime(4))
        self.assertTrue(is_prime(5))
        self.assertFalse(is_prime(9))
        self.assertTrue(is_prime(97))

    def test_even(self):
        for n in [6, 8, 10, 100]:
            self.assertFalse(is_prime(n))

if __name__ == "__main__":
    unittest.main()
