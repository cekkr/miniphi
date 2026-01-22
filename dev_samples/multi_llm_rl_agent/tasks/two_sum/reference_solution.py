from typing import List, Tuple

def two_sum(nums: List[int], target: int) -> Tuple[int, int]:
    seen = {}
    for i, x in enumerate(nums):
        need = target - x
        if need in seen:
            return (seen[need], i)
        seen[x] = i
    raise ValueError("No solution")
