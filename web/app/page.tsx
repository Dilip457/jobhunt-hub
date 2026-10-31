import { preload } from "react-dom";
import IntroPage from "@/components/IntroPage";

export default function HomePage() {
  // Only the intro needs the 3.7 MB guide model. Preloading it here instead of
  // in the root layout keeps it off the /jobs/* dashboards.
  preload("/models/student/student.glb", {
    as: "fetch",
    type: "model/gltf-binary",
    crossOrigin: "anonymous",
  });
  return <IntroPage />;
}
