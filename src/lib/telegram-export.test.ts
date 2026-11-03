import { describe, expect, it } from "vitest";

import { Transaction } from "./api";
import {
  ExportMessage,
  WizardRow,
  isInvalid,
  keysBetween,
  classifyMessage,
  markDuplicates,
  parseTelegramExport,
  planImport,
  restorePending,
  sortExport,
  splitList,
  toUtc,
} from "./telegram-export";

const THB = "THB";
const cl = (text: string) => classifyMessage(text, THB);

function message(id: number, body: string, title = "16 November 2024, 12:34:56"): string {
  return `<div class="message default clearfix" id="message${id}">
 <div class="body">
  <div class="pull_right date details" title="${title}">12:34</div>
  <div class="from_name">Test channel</div>
  ${body}
 </div>
</div>`;
}

const page = (...blocks: string[]) => `<!DOCTYPE html><html><head><title>Test &amp; channel</title></head><body>
<div class="message service" id="message-1"><div class="body details">16 November 2024</div></div>
${blocks.join("\n")}</body></html>`;

describe("parseTelegramExport", () => {
  it("reads the title, ids, dates and text, and ignores attachments even with a caption", () => {
    const parsed = parseTelegramExport([
      page(
        message(2, `<div class="text">100 water &amp; ice<br>second line</div>`),
        message(3, `<div class="media_wrap clearfix"><div class="media photo">Not included</div></div>`),
        message(5, `<div class="media_wrap clearfix"></div><div class="text">100 with a caption</div>`),
      ),
    ]);
    expect(parsed.title).toBe("Test & channel");
    expect(parsed.ignored).toBe(2);
    expect(parsed.messages).toEqual([
      { id: 2, date: "2024-11-16", time: "12:34:56", text: "100 water & ice\nsecond line" },
    ]);
  });

  it("merges the files of one export in message order", () => {
    const parsed = parseTelegramExport([
      page(message(7, `<div class="text">second</div>`)),
      page(message(3, `<div class="text">first</div>`), message(7, `<div class="text">second</div>`)),
    ]);
    expect(parsed.messages.map((m) => m.id)).toEqual([3, 7]);
  });

  it("reports a date it cannot read instead of guessing", () => {
    const parsed = parseTelegramExport([page(message(2, `<div class="text">100 tea</div>`, "16.11.2024 12:34"))]);
    expect(parsed.messages).toEqual([]);
    expect(parsed.badDates).toEqual(["16.11.2024 12:34"]);
  });
});

describe("classifyMessage", () => {
  it("a number first is an expense, with a plus an income", () => {
    expect(cl("135 скрепки")).toMatchObject({ bucket: "out", amount: "135", comment: "скрепки", reasons: [] });
    expect(cl("+515 от соседа")).toMatchObject({ bucket: "in", amount: "515", comment: "от соседа", reasons: [] });
    expect(cl("+ 515 от соседа")).toMatchObject({ bucket: "in", amount: "515" });
    expect(cl("133.25 чернила")).toMatchObject({ bucket: "out", amount: "133.25", comment: "чернила" });
    expect(cl("135")).toMatchObject({ bucket: "out", amount: "135", comment: "" });
  });

  it("a number first stays the amount, whatever else the text says", () => {
    expect(cl("88 7ка зонт")).toMatchObject({ bucket: "out", amount: "88", comment: "7ка зонт" });
    expect(cl("1400 снял с банка")).toMatchObject({ bucket: "out", amount: "1400", reasons: [] });
    expect(cl("15 долларов подписка")).toMatchObject({ bucket: "out", amount: "15", reasons: [] });
  });

  it("the only number elsewhere is the amount, with a plus before it an income", () => {
    expect(cl("Дыня 95 бат")).toMatchObject({ bucket: "out", amount: "95", comment: "Дыня", reasons: [] });
    expect(cl("Лавка 175")).toMatchObject({ bucket: "out", amount: "175", reasons: [] });
    expect(cl("Вечером +515 от соседа")).toMatchObject({ bucket: "in", amount: "515", comment: "Вечером от соседа" });
    expect(cl("От соседа + 515")).toMatchObject({ bucket: "in", amount: "515", comment: "От соседа" });
    expect(cl("#mybank 65 чернила")).toMatchObject({ bucket: "out", amount: "65" });
  });

  it("drops the account's currency and the word for cash from the comment", () => {
    expect(cl("135 бат зонт")).toMatchObject({ bucket: "out", amount: "135", comment: "зонт" });
    expect(cl("135бат зонт")).toMatchObject({ bucket: "out", amount: "135", comment: "зонт" });
    expect(cl("135 THB зонт")).toMatchObject({ bucket: "out", comment: "зонт" });
    expect(cl("#кеш 65 чернила")).toMatchObject({ bucket: "out", amount: "65", comment: "чернила" });
    expect(cl("Кеш 77 булочка")).toMatchObject({ bucket: "out", amount: "77", comment: "булочка" });
    expect(cl("Зонт 130 кеш")).toMatchObject({ bucket: "out", amount: "130", comment: "Зонт" });
    expect(classifyMessage("15 долларов подписка", "USD")).toMatchObject({ bucket: "out", comment: "подписка" });
  });

  it("several numbers go to review", () => {
    expect(cl("Скрепки 12 и зонт 30")).toMatchObject({ bucket: "review", amount: "12", reasons: ["severalNumbers"] });
    expect(cl("Прогулка кеш:\n\n41 зонт\n52 чернила").reasons).toEqual(["severalNumbers"]);
    expect(cl("41 зонт\n52 чернила")).toMatchObject({ bucket: "review", amount: "41", reasons: ["severalNumbers"] });
  });

  it("an amount not written plainly is read, and goes to review", () => {
    expect(cl("1.100 ремонт")).toMatchObject({ bucket: "review", amount: "1100", comment: "ремонт", reasons: ["looseAmount"] });
    expect(cl("6к бат аренда")).toMatchObject({ bucket: "review", amount: "6000", comment: "аренда", reasons: ["looseAmount"] });
    expect(cl("12 000 ремонт")).toMatchObject({ bucket: "review", amount: "12000", comment: "ремонт" });
    expect(cl("Снял 7к с банка")).toMatchObject({ bucket: "review", amount: "7000", reasons: ["looseAmount"] });
  });

  it("a number in front that is not an amount goes to review, empty", () => {
    expect(cl("7ка скрепки")).toMatchObject({ bucket: "review", amount: "", reasons: ["looseAmount"] });
    expect(cl("3й взнос потом")).toMatchObject({ bucket: "review", amount: "" });
    expect(cl("03/04 списание")).toMatchObject({ bucket: "review", amount: "" });
  });

  it("no number: ignore", () => {
    for (const text of ["Просто заметка", "Модель x9", "Ещё немного z5"]) {
      expect(cl(text).bucket, text).toBe("ignore");
    }
  });
});

describe("splitList", () => {
  it("takes the lines that start with an amount", () => {
    expect(splitList("Прогулка кеш:\n\n41 зонт\n52 бат чернила", THB)).toEqual([
      { amount: "41", comment: "зонт" },
      { amount: "52", comment: "чернила" },
    ]);
  });

  it("one such line is not a list", () => {
    expect(splitList("Прогулка\n41 зонт", THB)).toEqual([]);
  });
});

const msg = (id: number, text: string, date = "2026-01-10"): ExportMessage => ({ id, date, time: "12:00:00", text });

describe("sortExport", () => {
  it("leaves out imported messages and reports their edits", () => {
    const sorted = sortExport(
      [msg(1, "100 вода"), msg(2, "заметка"), msg(3, "200 чай"), msg(4, "300 новое"), msg(5, "теперь 400 кеш")],
      [
        { messageId: 1, status: "imported", text: "100 вода" },
        { messageId: 2, status: "skipped", text: "заметка" },
        { messageId: 3, status: "imported", text: "150 чай" },
        { messageId: 5, status: "skipped", text: "заметка" },
      ],
      [],
      THB,
    );
    expect(sorted.alreadyImported).toBe(2);
    expect(sorted.alreadySkipped).toBe(1);
    expect(sorted.edited).toEqual([{ messageId: 3, before: "150 чай", after: "200 чай" }]);
    expect(sorted.rows.map((r) => r.messageId)).toEqual([2, 4, 5]);
  });
});

describe("a message ignored earlier", () => {
  const known = [{ messageId: 1, status: "skipped", text: "100 вода" }];

  it("comes back on the ignore tab with a mark, its amount read", () => {
    const { rows, alreadySkipped } = sortExport([msg(1, "100 вода")], known, [], THB);
    expect(alreadySkipped).toBe(1);
    expect(rows[0]).toMatchObject({ bucket: "ignore", amount: "100", comment: "вода", reasons: ["ignoredEarlier"] });
  });

  it("left there, writes nothing", () => {
    const { rows } = sortExport([msg(1, "100 вода")], known, [], THB);
    expect(planImport(rows, "+07:00")).toEqual({ decisions: [], pending: [] });
  });

  it("moved to expenses, is imported", () => {
    const { rows } = sortExport([msg(1, "100 вода")], known, [], THB);
    const plan = planImport([{ ...rows[0], bucket: "out" }], "+07:00");
    expect(plan.decisions[0].entries).toHaveLength(1);
    expect(plan.decisions[0].entries[0]).toMatchObject({ direction: "out", amount: "100" });
  });

  it("moved to review, is saved for later", () => {
    const { rows } = sortExport([msg(1, "100 вода")], known, [], THB);
    const left = planImport([{ ...rows[0], bucket: "review" }], "+07:00").pending;
    expect(left.map((p) => p.messageId)).toEqual([1]);
    const again = sortExport([msg(1, "100 вода")], known, left, THB);
    expect(again.rows).toEqual([]);
    expect(again.alreadyPending).toBe(1);
  });

  it("with another text, is sorted anew", () => {
    const { rows, alreadySkipped } = sortExport([msg(1, "150 вода")], known, [], THB);
    expect(alreadySkipped).toBe(0);
    expect(rows[0]).toMatchObject({ bucket: "out", amount: "150", reasons: [] });
  });
});

describe("toUtc", () => {
  it("applies the chosen offset", () => {
    expect(toUtc("2026-01-10", "12:00:00", "+07:00")).toBe("2026-01-10T05:00:00.000Z");
    // A time edited in the wizard may come without seconds.
    expect(toUtc("2026-01-10", "12:30", "+07:00")).toBe("2026-01-10T05:30:00.000Z");
    expect(toUtc("2026-01-10", "01:00:00", "+07:00")).toBe("2026-01-09T18:00:00.000Z");
  });
});

function rowsOf(...messages: ExportMessage[]): WizardRow[] {
  return sortExport(messages, [], [], THB).rows;
}

function cash(at: string, amount: string, importBatchId: number | null = null, incoming = false): Transaction {
  return {
    id: 1,
    accountId: 1,
    importBatchId,
    occurredAtUtc: at,
    credit: incoming ? amount : "0.00",
    debit: incoming ? "0.00" : amount,
    balance: "0.00",
    peer: null,
    bankDescription: null,
    comment: null,
    isCorrecting: false,
  } as Transaction;
}

describe("markDuplicates", () => {
  it("sends a row that repeats a typed entry to review, one entry per row", () => {
    const rows = markDuplicates(
      rowsOf(msg(1, "100 вода"), msg(2, "100 вода"), msg(3, "200 чай")),
      [cash("2026-01-09T05:00:00.000Z", "100.00")],
      "+07:00",
    );
    expect(rows.map((r) => r.bucket)).toEqual(["review", "out", "out"]);
    expect(rows[0].reasons).toContain("possibleDuplicate");
    expect(rows[0].duplicateOf).toEqual({ date: "2026-01-09", amount: "100.00" });
  });

  it("ignores another direction, a distant date and entries from earlier imports", () => {
    const rows = markDuplicates(
      rowsOf(msg(1, "100 вода")),
      [
        cash("2026-01-10T05:00:00.000Z", "100.00", null, true),
        cash("2026-01-20T05:00:00.000Z", "100.00"),
        cash("2026-01-10T05:00:00.000Z", "100.00", 7),
      ],
      "+07:00",
    );
    expect(rows[0].bucket).toBe("out");
  });
});

describe("left for review", () => {
  const left = (id: number, text: string) => {
    const [row] = rowsOf(msg(id, text));
    return planImport([{ ...row, bucket: "review", amount: "321", comment: "поправлено" }], "+07:00").pending[0];
  };

  it("a saved message is not sorted again and comes back with its corrections", () => {
    const saved = left(1, "100 вода");
    const sorted = sortExport([msg(1, "100 вода"), msg(2, "200 чай")], [], [saved], THB);
    expect(sorted.alreadyPending).toBe(1);
    expect(sorted.rows.map((r) => r.messageId)).toEqual([2]);
    const restored = restorePending([saved], sorted.rows, THB, 500);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ key: 500, messageId: 1, bucket: "review", amount: "321", comment: "поправлено" });
  });

  it("restores without a file", () => {
    expect(restorePending([left(1, "100 вода")], [], THB, 0)).toHaveLength(1);
  });

  it("a message edited since is sorted anew, its draft dropped", () => {
    const saved = left(1, "100 вода");
    const sorted = sortExport([msg(1, "150 вода")], [], [saved], THB);
    expect(sorted.rows).toHaveLength(1);
    expect(sorted.rows[0].amount).toBe("150");
    expect(restorePending([saved], sorted.rows, THB, 0)).toEqual([]);
  });

  it("an unreadable draft falls back to the message itself", () => {
    const broken = { ...left(1, "100 вода"), rowsJson: "{" };
    expect(restorePending([broken], [], THB, 0)[0]).toMatchObject({ messageId: 1, amount: "100", bucket: "out" });
  });
});

describe("keysBetween", () => {
  it("takes the range in the order shown, either way", () => {
    expect(keysBetween([5, 3, 9, 1], 3, 1)).toEqual([3, 9, 1]);
    expect(keysBetween([5, 3, 9, 1], 1, 3)).toEqual([3, 9, 1]);
    expect(keysBetween([5, 3], 3, 3)).toEqual([3]);
  });

  it("a row no longer shown gives just the clicked one", () => {
    expect(keysBetween([5, 3], 7, 3)).toEqual([3]);
  });
});

describe("isInvalid", () => {
  const [row] = rowsOf(msg(1, "100 вода"));

  it("an entry needs a date, a time and an amount", () => {
    expect(isInvalid(row)).toBe(false);
    expect(isInvalid({ ...row, date: "" })).toBe(true);
    expect(isInvalid({ ...row, time: "" })).toBe(true);
    expect(isInvalid({ ...row, amount: "" })).toBe(true);
  });

  it("the rest does not count", () => {
    expect(isInvalid({ ...row, bucket: "ignore", amount: "" })).toBe(false);
  });
});

describe("planImport", () => {
  it("turns rows into decisions, skipped messages included", () => {
    const plan = planImport(rowsOf(msg(1, "100 вода"), msg(2, "+500 снял"), msg(3, "заметка")), "+07:00");
    expect(plan.pending).toEqual([]);
    expect(plan.decisions).toEqual([
      {
        messageId: 1,
        text: "100 вода",
        entries: [
          {
            occurredAtUtc: "2026-01-10T05:00:00.000Z",
            direction: "out",
            amount: "100",
            categoryId: null,
            comment: "вода",
          },
        ],
      },
      {
        messageId: 2,
        text: "+500 снял",
        entries: [expect.objectContaining({ direction: "in", amount: "500", comment: "снял" })],
      },
      { messageId: 3, text: "заметка", entries: [] },
    ]);
  });

  it("a message with a part in review waits as a whole", () => {
    const [first] = rowsOf(msg(1, "100 вода"));
    const plan = planImport(
      [first, { ...first, key: 1, isPart: true, bucket: "review" }],
      "+07:00",
    );
    expect(plan.decisions).toEqual([]);
    expect(plan.pending.map((p) => p.messageId)).toEqual([1]);
    expect(JSON.parse(plan.pending[0].rowsJson)).toHaveLength(2);
  });

  it("parts of a message become its entries", () => {
    const [first] = rowsOf(msg(1, "100 вода"));
    const plan = planImport([first, { ...first, key: 1, amount: "25", comment: "чай", isPart: true }], "+07:00");
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0].entries.map((e) => e.amount)).toEqual(["100", "25"]);
  });
});
