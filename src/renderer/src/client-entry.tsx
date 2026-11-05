import { render } from "@solidjs/web";
import { ClientAccountView } from "./client-account-view";
import { ClientLocaleProvider } from "./client-locale";
import "./client.css";

const root = document.getElementById("root");

if (!root) throw new Error("Renderer root element was not found.");

render(
  () => (
    <ClientLocaleProvider>
      <ClientAccountView />
    </ClientLocaleProvider>
  ),
  root,
);
