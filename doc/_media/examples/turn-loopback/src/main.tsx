import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./app.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("root container was not found");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
