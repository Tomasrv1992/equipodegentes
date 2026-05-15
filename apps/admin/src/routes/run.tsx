import { useParams } from "react-router-dom";
import RunDetail from "../components/RunDetail";

export default function RunRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <p>ID de run inválido.</p>;
  return <RunDetail runId={id} />;
}
