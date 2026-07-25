import React from "react";
import htm from "htm";

// Single htm↔React binding shared by every MiniPhi UI component so JSX-like
// markup works with no build step in this vanilla-ESM repo.
export const html = htm.bind(React.createElement);
export { React };
export { useState, useEffect, useRef, useMemo, useCallback } from "react";
