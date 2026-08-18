import { Request, Response, NextFunction } from 'express';
import { requestIdMiddleware, requestContextStore } from '../request-id';

describe('requestIdMiddleware', () => {
  let req: Partial<Request> & { requestId?: string };
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      headers: {},
      url: '/test',
      method: 'GET',
      requestId: undefined,
    };

    res = {
      setHeader: jest.fn(),
      on: jest.fn(),
      statusCode: 200,
    };

    next = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should generate a new UUID for X-Request-ID if header is missing', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Request-ID',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should forward the existing X-Request-ID if provided in request headers', () => {
    const existingRequestId = 'existing-trace-id-1234';
    req.headers = { 'x-request-id': existingRequestId };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', existingRequestId);
    expect(req.requestId).toBe(existingRequestId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should populate AsyncLocalStorage context during request execution', () => {
    let capturedStoreId: string | undefined;

    next = jest.fn(() => {
      // Access store inside next() execution block
      capturedStoreId = requestContextStore.getStore()?.requestId;
    });

    requestIdMiddleware(req as Request, res as Response, next);

    expect(capturedStoreId).toBeDefined();
    expect(capturedStoreId).toEqual(req.requestId);
  });
});