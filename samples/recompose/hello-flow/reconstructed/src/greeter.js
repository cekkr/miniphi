const greet = (name) => {
  const sanitizedName = name ? name.trim() : '';
  return sanitizedName ? `Hello, ${sanitizedName}!` : 'Hello!';
};

const farewell = (name) => {
  const sanitizedName = name ? name.trim() : '';
  return sanitizedName ? `Goodbye, ${sanitizedName}!` : 'Goodbye!';
};

exports.greet = greet;
exports.farewell = farewell;
