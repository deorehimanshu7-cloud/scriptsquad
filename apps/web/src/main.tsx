import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { AppProvider } from "./lib/state";
import { I18nProvider } from "./lib/i18n";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// toast stack lives outside the app tree so api.ts can append to it directly
const toastStack = document.createElement("div");
toastStack.id = "toast-stack";
toastStack.className = "toast-stack";
document.body.appendChild(toastStack);

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);