import { defineConfig } from 'cf/config';
import { configuration } from '../../infra/cloudflare.ts';

export default defineConfig(({ mode }) => configuration('execution', mode));
