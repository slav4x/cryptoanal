import { Button, EmptyState } from "@cryptoanal/ui";
import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <EmptyState
      title="Страница не найдена"
      description="Маршрут не существует или ещё не входит в текущий этап CryptoAnal."
      action={
        <Button asChild variant="outline">
          <Link to="/">Вернуться к обзору</Link>
        </Button>
      }
    />
  );
}
