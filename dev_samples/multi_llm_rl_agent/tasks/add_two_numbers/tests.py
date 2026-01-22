import unittest
from solution import add

class TestAdd(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(add(1, 2), 3)
        self.assertEqual(add(-5, 10), 5)
        self.assertEqual(add(0, 0), 0)

if __name__ == "__main__":
    unittest.main()
