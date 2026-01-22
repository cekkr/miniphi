import unittest
from solution import two_sum

class TestTwoSum(unittest.TestCase):
    def test_examples(self):
        self.assertEqual(two_sum([2,7,11,15], 9), (0, 1))
        self.assertEqual(two_sum([3,2,4], 6), (1, 2))
        self.assertEqual(two_sum([3,3], 6), (0, 1))

    def test_negative(self):
        self.assertEqual(two_sum([-1,-2,-3,-4,-5], -8), (2, 4))

if __name__ == "__main__":
    unittest.main()
