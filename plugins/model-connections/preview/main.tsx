import { createRoot } from "react-dom/client";
import { ConnectionsPanel } from "../app";
createRoot(document.getElementById("root")!).render(
  <ConnectionsPanel threadId="thread-example" />,
);
