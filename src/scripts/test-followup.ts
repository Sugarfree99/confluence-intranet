import qaService from "../services/qaService";

(async () => {
  // Simulate the chat from the screenshot.
  const history = [
    { role: "user" as const, content: "hur många semesterdagar har man om året?" },
    {
      role: "assistant" as const,
      content: "Informationen finns inte i den tillhandahållna kontexten.",
    },
  ];

  const r = await qaService.answerQuestion("Det finns i databasen", history);
  console.log("Answer:", r.answer);
  console.log("Sources:", r.sources.map((s) => s.title));

  await qaService.close();
})();
