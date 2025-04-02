// tests/app.test.js
const request = require('supertest');
const app = require('../app');

describe('Spotify Playlist Seller App', () => {
  let server;

  beforeAll(() => new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  }));

  afterAll(() => new Promise((resolve) => {
    server.close(() => resolve());
  }));

  it('should load the homepage with playlist sets', async () => {
    const response = await request(app).get('/').timeout(5000);
    expect(response.statusCode).toBe(200);
    expect(response.text).toContain('Buy Hip Hop Grammar Playlist Sets');
    expect(response.text).toContain('Buy Now');
  }, 10000);

  it('should redirect to Spotify login with setId', async () => {
    const response = await request(app).get('/login?setId=set1');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/spotify\.com/);
  });
});