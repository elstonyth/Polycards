// First, before anything else can call fetch: an expired login answering 401
// sends the browser to the login page (lib/login-redirect.ts).
import "./lib/login-redirect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mercurjs/admin/index.css";
import App from "@mercurjs/admin";
import "./admin-ui.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
