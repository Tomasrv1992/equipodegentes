import { useParams } from "react-router-dom";
import AgenteFicha from "../components/AgenteFicha";

export default function AgenteRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <p>ID inválido.</p>;
  return <AgenteFicha id={id} />;
}
