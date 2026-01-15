const greet = (name) => {
  if (!name || typeof name !== 'string') {
    return { error: 'Invalid input' };
  }
  const sanitizedName = name.trim();
  console.log({ event: 'greet', name: sanitizedName });
  return `Hello, ${sanitizedName}!`;
};

const farewell = (name) => {
  if (!name || typeof name !== 'string') {
    return { error: 'Invalid input' };
  }
  const sanitizedName = name.trim();
  console.log({ event: 'farewell', name: sanitizedName });
  return `Goodbye, ${sanitizedName}!`;
};

module.exports = { greet, farewell };
