import { schema, table, t } from 'spacetimedb/server';
import { coreHello } from '../../core/src/hello';

const probe = table({ name: 'probe', public: true }, { id: t.u32().primaryKey(), v: t.f64() });
const spacetimedb = schema({ probe });
export default spacetimedb;

export const doProbe = spacetimedb.reducer({ x: t.f64() }, (ctx, { x }) => {
  ctx.db.probe.insert({ id: 1, v: coreHello(x) });
});
