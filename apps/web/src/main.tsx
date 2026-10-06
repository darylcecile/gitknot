import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app.tsx";
import { AuthProvider } from "./auth.tsx";
import "./styles.css";

const root = document.getElementById("root");
document.addEventListener(
  "keydown",
  () => {
    document.documentElement.dataset.input = "keyboard";
  },
  { capture: true },
);
document.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.input = "pointer";
  },
  { capture: true },
);
if (!root) throw new Error("GitKnot root element is missing.");
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
