import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setWatchlisted } from "../../shared/api";

export function useWatchlistMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ symbol, watchlisted }: { symbol: string; watchlisted: boolean }) =>
      setWatchlisted(symbol, watchlisted),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["markets"] }),
        queryClient.invalidateQueries({ queryKey: ["market", variables.symbol] }),
      ]);
    },
  });
}
