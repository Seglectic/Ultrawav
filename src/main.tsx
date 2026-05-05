import React from "react";
import { createRoot } from "react-dom/client";

import "./style.css";
import { App } from "./App";

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Missing #app root.");
}

createRoot(appElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
