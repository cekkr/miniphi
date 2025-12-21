export const average = (arr) => {
  if (!Array.isArray(arr)) return null;
  const nums = arr.filter(n => typeof n === 'number' && !isNaN(n));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};

export const describeTrend = (arr) => {
  if (!Array.isArray(arr)) return 'invalid';
  const nums = arr.filter(n => typeof n === 'number' && !isNaN(n));
  if (nums.length < 2) return 'insufficient data';
  const trend = nums[nums.length - 1] - nums[0];
  return trend > 0 ? 'upward' : trend < 0 ? 'downward' : 'stable';
};
