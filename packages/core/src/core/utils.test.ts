import { describe, it, expect } from 'vitest';
import { extractRepoFromUrl } from './utils.js';

describe('extractRepoFromUrl', () => {
  it('extracts from PR URL', () => {
    expect(extractRepoFromUrl('https://github.com/owner/repo/pull/123')).toBe('owner/repo');
  });

  it('extracts from issue URL', () => {
    expect(extractRepoFromUrl('https://github.com/owner/repo/issues/456')).toBe('owner/repo');
  });

  it('extracts from API URL', () => {
    expect(extractRepoFromUrl('https://api.github.com/repos/owner/repo')).toBe('owner/repo');
  });

  it('extracts from API URL with subpath', () => {
    expect(extractRepoFromUrl('https://api.github.com/repos/owner/repo/issues/1')).toBe('owner/repo');
  });

  it('extracts from plain repo URL', () => {
    expect(extractRepoFromUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('extracts from repo URL with trailing slash', () => {
    expect(extractRepoFromUrl('https://github.com/owner/repo/')).toBe('owner/repo');
  });

  it('returns null for non-GitHub URL', () => {
    expect(extractRepoFromUrl('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractRepoFromUrl('')).toBeNull();
  });

  it('returns null for malformed URL', () => {
    expect(extractRepoFromUrl('not-a-url')).toBeNull();
  });
});
