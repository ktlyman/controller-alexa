import { AlexaApiClient } from '../../src/alexa-api/alexa-api-client';
import type {
  RawSmartHomeEntity,
  RawEchoDevice,
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

  describe('getAllDevices', () => {
    it('should normalize and merge devices from all sources', async () => {
      client.setCredentials({
        cookie: 'session=abc',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      // Smart home response
      mockResponse(200, JSON.stringify([
        {
          entityId: 'sh-1',
          entityType: 'APPLIANCE',
          friendlyName: 'Kitchen Light',
          providerData: { categoryType: 'LIGHT', manufacturerName: 'LIFX' },
          capabilities: [{ capabilityType: 'AlexaInterface', interfaceName: 'Alexa.PowerController' }],
          reachable: true,
        },
      ]));

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
          members: [{ id: 'sh-1', type: 'APPLIANCE' }],
        },
      ]));

      const devices = await client.getAllDevices();
      expect(devices).toHaveLength(2);

      const light = devices.find((d) => d.id === 'sh-1')!;
      expect(light.name).toBe('Kitchen Light');
      expect(light.source).toBe('smart_home');
      expect(light.deviceType).toBe('LIGHT');
      expect(light.manufacturer).toBe('LIFX');
      expect(light.capabilities).toContain('Alexa.PowerController');
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

      // Smart home succeeds
      mockResponse(200, JSON.stringify([
        {
          entityId: 'sh-1',
          entityType: 'APPLIANCE',
          friendlyName: 'Light',
          reachable: true,
        },
      ]));

      // Echo fails
      mockResponse(500, 'Internal Server Error');

      // Groups fails
      mockResponse(500, 'Internal Server Error');

      const devices = await client.getAllDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe('sh-1');
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

    it('should return false on 401 response', async () => {
      client.setCredentials({
        cookie: 'expired=cookie',
        csrf: 'tok',
        storedAt: new Date().toISOString(),
      });

      mockResponse(401, 'Unauthorized');

      const valid = await client.validateCookie();
      expect(valid).toBe(false);
    });
  });
});
