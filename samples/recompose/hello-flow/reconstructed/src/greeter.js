const greet = (name) => {
  const sanitizedName = name ?? 'Guest';
  return `Hello, ${sanitizedName}!`;
};

const farewell = (name) => {
  const sanitizedName = name ?? 'Guest';
  return `Goodbye, ${sanitizedName}!`;
};

exports.greet = greet;
exports.farewell = farewell;
