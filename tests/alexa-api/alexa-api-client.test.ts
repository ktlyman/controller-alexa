import { AlexaApiClient } from '../../src/alexa-api/alexa-api-client';
import type {
  RawSmartHomeEntity,
  RawEchoDevice,
  GraphQLEndpointItem,
  AccountDevice,
} from '../../src/alexa-api/alexa-api-types';

// We mock https to avoid real network calls
jest.mock('https', () => ({
  request: jest.fn(),
}));

import https from 'https';
import { EventEmitter } from 'events';

const mockHttps = https as jest.Mocked<typeof https>;

function mockResponse(statusCode: number, body: string) {
  (mockHttps.request as jest.Mock).mockImplementationOnce((_opts: any, callback: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = statusCode;
    res.headers = {};

    const req = new EventEmitter() as any;
    req.write = jest.fn();
    req.end = jest.fn(() => {
      process.nextTick(() => {
        callback(res);
        res.emit('data', body);
        res.emit('end');
      });
    });

    return req;
  });
}

describe('AlexaApiClient', () => {
  let client: AlexaApiClient;

  beforeEach(() => {
    client = new AlexaApiClient('NA');
    jest.clearAllMocks();
  });

  describe('credential management', () => {
    it('should start with no credentials', () => {
      expect(client.hasValidCredentials()).toBe(false);
      expect(client.getCredentials()).toBeNull();
    });

    it('should store credentials', () => {
      client.setCredentials({
        cookie: 'session-id=abc',
        csrf: 'token123',
        storedAt: new Date().toISOString(),
      });
      expect(client.hasValidCredentials()).toBe(true);
      expect(client.getCredentials()!.csrf).toBe('token123');
    });

    it('should auto-extract CSRF from cookie string', () => {
      client.setCredentials({
        cookie: 'session-id=abc; csrf=auto-extracted-token; other=val',
        storedAt: new Date().toISOString(),
      });
      expect(client.getCredentials()!.csrf).toBe('auto-extracted-token');
    });

    it('should not overwrite explicit CSRF with auto-extract', () => {
      client.setCredentials({
        cookie: 'csrf=from-cookie',
        csrf: 'explicit-value',
        storedAt: new Date().toISOString(),
      });
      expect(client.getCredentials()!.csrf).toBe('explicit-value');
    });

    it('should report empty cookie as invalid', () => {
      client.setCredentials({
        cookie: '',
        storedAt: new Date().toISOString(),
      });
      expect(client.hasValidCredentials()).toBe(false);
    });
  });

  describe('getSmartHomeDevices', () => {
    it('should throw without credentials', async () => {
      await expect(client.getSmartHomeDevices()).rejects.toThrow('No Alexa cookie configured');
    });

    it('should parse smart home entities', async () => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      const entities: RawSmartHomeEntity[] = [
        {
          entityId: 'entity-1',
          entityType: 'APPLIANCE',
          friendlyName: 'Living Room Light',
          providerData: {
            categoryType: 'LIGHT',
            manufacturerName: 'Philips',
            modelName: 'Hue A19',
            skillId: 'amzn1.ask.skill.hue',
          },
          capabilities: [
            { capabilityType: 'AlexaInterface', interfaceName: 'Alexa.PowerController' },
            { capabilityType: 'AlexaInterface', interfaceName: 'Alexa.BrightnessController' },
          ],
          reachable: true,
        },
      ];

      mockResponse(200, JSON.stringify(entities));

      const result = await client.getSmartHomeDevices();
      expect(result).toHaveLength(1);
      expect(result[0].entityId).toBe('entity-1');
      expect(result[0].friendlyName).toBe('Living Room Light');
    });

    it('should throw on 401 (expired cookie)', async () => {
      client.setCredentials({
        cookie: 'expired=cookie',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      mockResponse(401, 'Unauthorized');

      await expect(client.getSmartHomeDevices()).rejects.toThrow('cookie expired');
    });

    it('should throw on 302 redirect (expired cookie)', async () => {
      client.setCredentials({
        cookie: 'expired=cookie',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      mockResponse(302, '<html>Login page</html>');

      await expect(client.getSmartHomeDevices()).rejects.toThrow('cookie expired');
    });
  });

  describe('getEchoDevices', () => {
    it('should parse Echo device list', async () => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      const response = {
        devices: [
          {
            accountName: "Kevin's Echo Dot",
            serialNumber: 'ECHO123',
            deviceType: 'A3S5BH2HU6VAYF',
            deviceOwnerCustomerId: 'CUST123',
            softwareVersion: '1234',
            online: true,
            capabilities: ['AUDIO_PLAYER', 'VOLUME_SETTING'],
            deviceFamily: 'ECHO',
            deviceTypeFriendlyName: 'Echo Dot',
          },
        ],
      };

      mockResponse(200, JSON.stringify(response));

      const result = await client.getEchoDevices();
      expect(result).toHaveLength(1);
      expect(result[0].serialNumber).toBe('ECHO123');
      expect(result[0].online).toBe(true);
    });
  });

  describe('getSmartHomeEndpoints', () => {
    it('should parse GraphQL endpoint response', async () => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      const graphqlResponse = {
        data: {
          endpoints: {
            items: [
              {
                endpointId: 'amzn1.alexa.endpoint.abc',
                id: 'amzn1.alexa.endpoint.abc',
                friendlyName: 'Kitchen Light',
                displayCategories: { primary: { value: 'LIGHT' } },
                legacyAppliance: {
                  applianceId: 'app-1',
                  applianceTypes: ['LIGHT'],
                  manufacturerName: 'LIFX',
                  modelName: 'A19',
                  actions: ['turnOn', 'turnOff', 'setBrightness'],
                  isEnabled: true,
                },
                enablement: 'ENABLED',
                manufacturer: { value: { text: 'LIFX' } },
                model: { value: { text: 'A19' } },
                features: [
                  { name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] },
                  { name: 'brightness', operations: [{ name: 'setBrightness' }] },
                ],
              },
            ],
          },
        },
      };

      mockResponse(200, JSON.stringify(graphqlResponse));

      const result = await client.getSmartHomeEndpoints();
      expect(result).toHaveLength(1);
      expect(result[0].friendlyName).toBe('Kitchen Light');
      expect(result[0].displayCategories?.primary?.value).toBe('LIGHT');
    });
  });

  describe('getAllDevices', () => {
    it('should normalize and merge devices from GraphQL + Echo sources', async () => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      // GraphQL smart home endpoints
      mockResponse(200, JSON.stringify({
        data: {
          endpoints: {
            items: [
              {
                endpointId: 'amzn1.alexa.endpoint.sh1',
                id: 'amzn1.alexa.endpoint.sh1',
                friendlyName: 'Kitchen Light',
                displayCategories: { primary: { value: 'LIGHT' } },
                legacyAppliance: {
                  applianceId: 'app-sh1',
                  manufacturerName: 'LIFX',
                  applianceNetworkState: { reachability: 'REACHABLE' },
                },
                enablement: 'ENABLED',
                manufacturer: { value: { text: 'LIFX' } },
                features: [
                  { name: 'power', operations: [{ name: 'turnOn' }, { name: 'turnOff' }] },
                ],
              },
            ],
          },
        },
      }));

      // Echo response
      mockResponse(200, JSON.stringify({
        devices: [
          {
            accountName: 'Bedroom Echo',
            serialNumber: 'ECHO-1',
            deviceType: 'ECHO_DOT',
            deviceOwnerCustomerId: 'C1',
            softwareVersion: '1',
            online: true,
            capabilities: ['AUDIO_PLAYER'],
            deviceFamily: 'ECHO',
          },
        ],
      }));

      // Groups response
      mockResponse(200, JSON.stringify([
        {
          groupId: 'g1',
          groupName: 'Kitchen',
          groupType: 'ROOM',
          members: [{ id: 'amzn1.alexa.endpoint.sh1', type: 'APPLIANCE' }],
        },
      ]));

      const devices = await client.getAllDevices();
      expect(devices).toHaveLength(2);

      const light = devices.find((d) => d.id === 'amzn1.alexa.endpoint.sh1')!;
      expect(light.name).toBe('Kitchen Light');
      expect(light.source).toBe('smart_home');
      expect(light.deviceType).toBe('LIGHT');
      expect(light.manufacturer).toBe('LIFX');
      expect(light.capabilities).toContain('turnOn');
      expect(light.capabilities).toContain('turnOff');
      expect(light.groups).toContain('Kitchen');

      const echo = devices.find((d) => d.id === 'ECHO-1')!;
      expect(echo.name).toBe('Bedroom Echo');
      expect(echo.source).toBe('echo');
      expect(echo.manufacturer).toBe('Amazon');
    });

    it('should handle partial failures gracefully', async () => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      // GraphQL endpoints succeed
      mockResponse(200, JSON.stringify({
        data: {
          endpoints: {
            items: [
              {
                id: 'ep-1',
                endpointId: 'ep-1',
                friendlyName: 'Light',
                displayCategories: { primary: { value: 'LIGHT' } },
                enablement: 'ENABLED',
                features: [],
              },
            ],
          },
        },
      }));

      // Echo fails
      mockResponse(500, 'Internal Server Error');

      // Groups fails
      mockResponse(500, 'Internal Server Error');

      const devices = await client.getAllDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe('ep-1');
    });
  });

  describe('sendCommand', () => {
    beforeEach(() => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });
    });

    it('should build turn_on payload', async () => {
      mockResponse(200, '{}');

      await client.sendCommand({
        deviceId: 'dev-1',
        deviceType: 'LIGHT',
        command: { action: 'turn_on' },
      });

      // Verify the request was made
      expect(mockHttps.request).toHaveBeenCalled();
      const reqCall = (mockHttps.request as jest.Mock).mock.calls[0];
      expect(reqCall[0].method).toBe('POST');
      expect(reqCall[0].path).toContain('/api/behaviors/operation');
    });

    it('should build set_brightness payload', async () => {
      let capturedBody = '';
      (mockHttps.request as jest.Mock).mockImplementationOnce((_opts: any, callback: any) => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        const req = new EventEmitter() as any;
        req.write = jest.fn((data: string) => { capturedBody = data; });
        req.end = jest.fn(() => {
          process.nextTick(() => { callback(res); res.emit('data', '{}'); res.emit('end'); });
        });
        return req;
      });

      await client.sendCommand({
        deviceId: 'dev-1',
        deviceType: 'LIGHT',
        command: { action: 'set_brightness', brightness: 75 },
      });

      const body = JSON.parse(capturedBody);
      const sequence = JSON.parse(body.sequenceJson);
      expect(sequence.startNode.operationPayload.type).toBe('Alexa.DeviceControls.Brightness');
      expect(sequence.startNode.operationPayload.brightness).toBe(75);
    });

    it('should build speak payload', async () => {
      let capturedBody = '';
      (mockHttps.request as jest.Mock).mockImplementationOnce((_opts: any, callback: any) => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        const req = new EventEmitter() as any;
        req.write = jest.fn((data: string) => { capturedBody = data; });
        req.end = jest.fn(() => {
          process.nextTick(() => { callback(res); res.emit('data', '{}'); res.emit('end'); });
        });
        return req;
      });

      await client.sendCommand({
        deviceId: 'echo-1',
        deviceType: 'ECHO',
        command: { action: 'speak', text: 'Hello world' },
      });

      const body = JSON.parse(capturedBody);
      const sequence = JSON.parse(body.sequenceJson);
      expect(sequence.startNode.operationPayload.type).toBe('Alexa.Speak');
      expect(sequence.startNode.operationPayload.textToSpeak).toBe('Hello world');
    });

    it('should throw on error response', async () => {
      mockResponse(400, 'Bad Request');

      await expect(
        client.sendCommand({
          deviceId: 'dev-1',
          deviceType: 'LIGHT',
          command: { action: 'turn_on' },
        }),
      ).rejects.toThrow('Alexa command failed');
    });
  });

  describe('getDeviceStates', () => {
    beforeEach(() => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });
    });

    it('should throw without credentials', async () => {
      const noCredClient = new AlexaApiClient('NA');
      await expect(noCredClient.getDeviceStates(['e1'])).rejects.toThrow('No Alexa cookie');
    });

    it('should parse phoenix state with double-encoded capabilityStates', async () => {
      const phoenixResponse = {
        deviceStates: [
          {
            entity: { entityId: 'entity-1', entityType: 'APPLIANCE' },
            capabilityStates: [
              JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON', timeOfSample: '2024-06-01T00:00:00Z' }),
              JSON.stringify({ namespace: 'Alexa.BrightnessController', name: 'brightness', value: 75 }),
            ],
          },
        ],
      };

      mockResponse(200, JSON.stringify(phoenixResponse));

      const result = await client.getDeviceStates(['entity-1']);
      expect(result).toHaveLength(1);
      expect(result[0].deviceId).toBe('entity-1');
      expect(result[0].capabilities).toHaveLength(2);
      expect(result[0].capabilities[0].namespace).toBe('Alexa.PowerController');
      expect(result[0].capabilities[0].value).toBe('ON');
      expect(result[0].capabilities[1].value).toBe(75);
      expect(result[0].error).toBeUndefined();
    });

    it('should handle device errors in response', async () => {
      const phoenixResponse = {
        deviceStates: [
          {
            entity: { entityId: 'unreachable-1', entityType: 'APPLIANCE' },
            error: { code: 'DEVICE_UNREACHABLE', message: 'Device not responding' },
          },
        ],
      };

      mockResponse(200, JSON.stringify(phoenixResponse));

      const result = await client.getDeviceStates(['unreachable-1']);
      expect(result).toHaveLength(1);
      expect(result[0].error).toContain('DEVICE_UNREACHABLE');
      expect(result[0].capabilities).toEqual([]);
    });

    it('should handle malformed capability states gracefully', async () => {
      const phoenixResponse = {
        deviceStates: [
          {
            entity: { entityId: 'entity-1', entityType: 'APPLIANCE' },
            capabilityStates: [
              JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' }),
              'not-valid-json{{{',
            ],
          },
        ],
      };

      mockResponse(200, JSON.stringify(phoenixResponse));

      const result = await client.getDeviceStates(['entity-1']);
      expect(result).toHaveLength(1);
      // Only the valid one should be parsed
      expect(result[0].capabilities).toHaveLength(1);
      expect(result[0].capabilities[0].value).toBe('ON');
    });

    it('should apply deviceNameMap', async () => {
      const phoenixResponse = {
        deviceStates: [
          {
            entity: { entityId: 'entity-1', entityType: 'APPLIANCE' },
            capabilityStates: [],
          },
        ],
      };

      mockResponse(200, JSON.stringify(phoenixResponse));

      const nameMap = new Map([['entity-1', 'Kitchen Light']]);
      const result = await client.getDeviceStates(['entity-1'], nameMap);
      expect(result[0].deviceName).toBe('Kitchen Light');
    });
  });

  describe('getActivityHistory', () => {
    beforeEach(() => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });
    });

    it('should throw without credentials', async () => {
      const noCredClient = new AlexaApiClient('NA');
      await expect(noCredClient.getActivityHistory()).rejects.toThrow('No Alexa cookie');
    });

    it('should parse activity history records', async () => {
      const historyResponse = {
        customerHistoryRecords: [
          {
            recordKey: 'rec-1',
            creationTimestamp: 1704067200000, // 2024-01-01T00:00:00Z
            utteranceType: 'VOICE',
            device: {
              deviceName: 'Echo Dot',
              deviceType: 'ECHO_DOT',
              serialNumber: 'SERIAL1',
            },
            voiceHistoryRecordItems: [
              { recordItemKey: 'item-1', recordItemType: 'CUSTOMER_TRANSCRIPT', transcriptText: 'turn on the lights' },
              { recordItemKey: 'item-2', recordItemType: 'ALEXA_RESPONSE', transcriptText: 'OK' },
            ],
          },
        ],
        encodedRequestToken: 'next-page-token',
      };

      mockResponse(200, JSON.stringify(historyResponse));

      const result = await client.getActivityHistory();
      expect(result.records).toHaveLength(1);
      expect(result.records[0].id).toBe('rec-1');
      expect(result.records[0].utteranceText).toBe('turn on the lights');
      expect(result.records[0].responseText).toBe('OK');
      expect(result.records[0].deviceSerial).toBe('SERIAL1');
      expect(result.records[0].deviceName).toBe('Echo Dot');
      expect(result.nextToken).toBe('next-page-token');
    });

    it('should use www.amazon.com as base URL', async () => {
      mockResponse(200, JSON.stringify({ customerHistoryRecords: [] }));

      await client.getActivityHistory();

      const reqCall = (mockHttps.request as jest.Mock).mock.calls[0];
      expect(reqCall[0].hostname).toBe('www.amazon.com');
      expect(reqCall[0].path).toContain('/alexa-privacy/');
    });

    it('should pass pagination token', async () => {
      let capturedBody = '';
      (mockHttps.request as jest.Mock).mockImplementationOnce((_opts: any, callback: any) => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        const req = new EventEmitter() as any;
        req.write = jest.fn((data: string) => { capturedBody = data; });
        req.end = jest.fn(() => {
          process.nextTick(() => {
            callback(res);
            res.emit('data', JSON.stringify({ customerHistoryRecords: [] }));
            res.emit('end');
          });
        });
        return req;
      });

      await client.getActivityHistory({ nextToken: 'page-2-token' });

      const body = JSON.parse(capturedBody);
      expect(body.previousRequestToken).toBe('page-2-token');
    });

    it('should default to 7-day window', async () => {
      let capturedBody = '';
      (mockHttps.request as jest.Mock).mockImplementationOnce((_opts: any, callback: any) => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        const req = new EventEmitter() as any;
        req.write = jest.fn((data: string) => { capturedBody = data; });
        req.end = jest.fn(() => {
          process.nextTick(() => {
            callback(res);
            res.emit('data', JSON.stringify({ customerHistoryRecords: [] }));
            res.emit('end');
          });
        });
        return req;
      });

      const before = Date.now();
      await client.getActivityHistory();
      const after = Date.now();

      const body = JSON.parse(capturedBody);
      // endTimestamp should be roughly now
      expect(body.endTimestamp).toBeGreaterThanOrEqual(before);
      expect(body.endTimestamp).toBeLessThanOrEqual(after);
      // startTimestamp should be roughly 7 days ago
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(body.startTimestamp).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
      expect(body.startTimestamp).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
    });
  });

  describe('validateCookie', () => {
    it('should return false without credentials', async () => {
      const valid = await client.validateCookie();
      expect(valid).toBe(false);
    });

    it('should return true on 200 response', async () => {
      client.setCredentials({
        cookie: 'valid=cookie',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      mockResponse(200, '{"authenticated":true}');

      const valid = await client.validateCookie();
      expect(valid).toBe(true);
    });

    it('should return false on 401 from both bootstrap and devices', async () => {
      client.setCredentials({
        cookie: 'expired=cookie',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      // Bootstrap returns 401
      mockResponse(401, 'Unauthorized');
      // Fallback devices endpoint also returns 401
      mockResponse(401, 'Unauthorized');

      const valid = await client.validateCookie();
      expect(valid).toBe(false);
    });

    it('should return true when bootstrap fails but devices succeeds', async () => {
      client.setCredentials({
        cookie: 'valid=cookie',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      // Bootstrap returns redirect
      mockResponse(302, 'Redirect');
      // Fallback devices endpoint succeeds
      mockResponse(200, '{"devices":[]}');

      const valid = await client.validateCookie();
      expect(valid).toBe(true);
    });
  });
});
