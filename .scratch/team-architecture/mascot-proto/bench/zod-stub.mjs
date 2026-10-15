export const z = { enum: ids => ({ safeParse: v => ({ data: ids.includes(v) ? v : undefined }) }) };
