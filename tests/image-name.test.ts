import { describe, expect, it } from 'bun:test';
import { buildGroupImageName, parseImageName } from '../packages/framework/compiler/image-name';

describe('parseImageName', () => {
  it('should parse image without tag', () => {
    expect(parseImageName('myrepo/myimage')).toEqual({
      base: 'myrepo/myimage',
      tag: '',
    });
  });

  it('should parse image with tag', () => {
    expect(parseImageName('myrepo/myimage:v1.0')).toEqual({
      base: 'myrepo/myimage',
      tag: 'v1.0',
    });
  });

  it('should handle registry with port', () => {
    expect(parseImageName('localhost:5000/myimage:latest')).toEqual({
      base: 'localhost:5000/myimage',
      tag: 'latest',
    });
  });

  it('should handle registry with port and no tag', () => {
    expect(parseImageName('localhost:5000/myimage')).toEqual({
      base: 'localhost:5000/myimage',
      tag: '',
    });
  });

  it('should handle simple image name', () => {
    expect(parseImageName('nginx')).toEqual({
      base: 'nginx',
      tag: '',
    });
  });

  it('should handle simple image with tag', () => {
    expect(parseImageName('nginx:alpine')).toEqual({
      base: 'nginx',
      tag: 'alpine',
    });
  });

  it('should handle multi-level registry paths', () => {
    expect(parseImageName('gcr.io/my-project/my-app:v2')).toEqual({
      base: 'gcr.io/my-project/my-app',
      tag: 'v2',
    });
  });

  it('should handle image with multiple colons in registry', () => {
    expect(parseImageName('host:8080/repo:prod/image:tag')).toEqual({
      base: 'host:8080/repo:prod/image',
      tag: 'tag',
    });
  });
});

describe('buildGroupImageName', () => {
  it('should append group name without tag', () => {
    expect(buildGroupImageName('myrepo/myimage', 'api')).toBe('myrepo/myimage-api');
  });

  it('should append group name with tag', () => {
    expect(buildGroupImageName('myrepo/myimage:v1.0', 'api')).toBe('myrepo/myimage-api:v1.0');
  });

  it('should handle registry with port', () => {
    expect(buildGroupImageName('localhost:5000/myimage:latest', 'dashboard')).toBe(
      'localhost:5000/myimage-dashboard:latest',
    );
  });

  it('should handle simple image names', () => {
    expect(buildGroupImageName('nginx', 'web')).toBe('nginx-web');
    expect(buildGroupImageName('nginx:alpine', 'web')).toBe('nginx-web:alpine');
  });

  it('should handle complex group names', () => {
    expect(buildGroupImageName('myrepo/app:v1', 'user-api')).toBe('myrepo/app-user-api:v1');
  });
});
