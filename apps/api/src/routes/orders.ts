import {AppError, ORDER_CODE_PATTERN} from '@gift-inspector/shared';
import type {FastifyPluginAsync} from 'fastify';

import {findOrder, listOrders} from '../db/orders';
import type {AppDeps} from '../app';

export const ordersRoutes: FastifyPluginAsync<AppDeps> = async (app, {db}) => {
  app.get('/api/orders', async () => {
    return {orders: await listOrders(db)};
  });

  app.get<{Params: {code: string}}>('/api/orders/:code', async request => {
    const {code} = request.params;
    if (!ORDER_CODE_PATTERN.test(code)) {
      throw new AppError('ORDER_NOT_FOUND', {detail: 'コードの形式が不正'});
    }
    const order = await findOrder(db, code);
    if (!order) throw new AppError('ORDER_NOT_FOUND', {detail: code});
    return {order};
  });
};
