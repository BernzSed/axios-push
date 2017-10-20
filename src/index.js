import url from 'url';
import { CancelToken } from 'axios';
import isAbsoluteUrl from 'axios/lib/helpers/isAbsoluteURL';
import combineURLs from 'axios/lib/helpers/combineURLs';
import { merge } from 'axios/lib/utils';
import getTargetAxios from './getTargetAxios';
import emptyPromise from './emptyPromise';
import ResponsePool from './responsePool';
import {
  responseInterceptor,
  responseRejectedInterceptor
} from './responseInterceptors';

const pushableMethods = ['GET']; // TODO can I push_promise HEAD?

function canPush(pageResponse, requestURL, config) {
  return pageResponse &&
    !pageResponse.finished &&
    pageResponse.stream &&
    pageResponse.stream.pushAllowed &&
    pushableMethods.includes(config.method.toUpperCase());
  // TODO also check domain
  // TODO don't push the same thing multiple times. Browser will send RST_STREAM
}

function getRequestConfig(params, method, hasData, targetAxios) {
  const paramsConfig = hasData ?
    getRequestConfigWithData(method, params) :
    getRequestConfigWithoutData(method, params);

  // TODO maybe don't use so many internal functions from axios/lib
  return merge(targetAxios.defaults, paramsConfig);
}

// for request that contain no data (GET, HEAD, DELETE)
function getRequestConfigWithoutData(method, [arg1, arg2]) {
  if (typeof arg1 === 'string') {
    const config = { ...arg2 };
    config.url = arg1;
    config.method = method || config.method || 'GET';
    return config;
  } else {
    return arg1;
  }
}
// for requests that contain data (POST, PUT)
function getRequestConfigWithData(method, [arg1, arg2, arg3]) {
  if (typeof arg1 === 'string') {
    const config = { ...arg3 };
    config.url = arg1;
    config.method = method || config.method || 'POST';
    return config;
  } else {
    return arg2 || arg1;
  }
}

function getWord(str) {
  const result = str && /\w+/.exec(str);
  return result && result[0];
}

function getRequestHeaders(config, requestURL) {
  const requestHeaders = {
    ...(config.headers || {}).common,
    ...(config.headers || {})[config.method],
    ...config.headers,
    ':path': requestURL.path,
    ':authority': requestURL.host,
    ':method': config.method.toUpperCase(),
    ':scheme': getWord(requestURL.protocol) || 'https'
  };

  // duplicating axios's internal logic from /lib/core/dispatchRequest.js
  ['delete', 'get', 'head', 'post', 'put', 'patch', 'common']
    .forEach(function cleanHeaderConfig(method) {
      delete requestHeaders[method];
    });

  return requestHeaders;
}

/**
 * Wraps axios in something that will monitor requests/responses and
 * will issue push promises
 * @param {pageResponse} http2.Http2ServerResponse
 * @param {axiosParam} (optional) instance of axios, or axios config object
 * @return {object} returns an axios instance that will issue push promises automatically.
 */
export default function prepareAxios(pageResponse, axiosParam = null) {
  const targetAxios = getTargetAxios(axiosParam);

  if (global.window || !pageResponse) {
    // don't wrap it if on client side
    return targetAxios;
  }

  const responsePool = new ResponsePool();
  responsePool.add(pageResponse);

  // Unfortunately, we can't use a real request interceptor.
  // Axios doesn't call its request interceptors immediately, so the
  // page response stream could close before we have a chance to send
  // the push promise.
  // This is why we have to wrap axios instead of just adding interceptors.

  function interceptRequest(params, method, hasData) {
    const config = getRequestConfig(params, method, hasData, targetAxios);

    const baseURL = config.baseURL || targetAxios.defaults.baseURL;
    const requestURLString = baseURL && !isAbsoluteUrl(config.url) ?
      combineURLs(baseURL, config.url) :
      config.url;
    const requestURL = url.parse(requestURLString);

    const serverResponse = responsePool.get();

    // TODO FIXME FIXME
    // So, it turns out this is not allowed, per the spec:
    // "PUSH_PROMISE frames MUST only be sent on a peer-initiated stream"
    // https://bugs.chromium.org/p/chromium/issues/detail?id=585477
    // I HAVE to use the client-initiated stream. Which is possible,
    // but complicated because the stream must be kept open.
    // TODO add a promise the dev can wait for before calling response.end()

    if (canPush(serverResponse, requestURL, config)) {
      // issue a push promise, with correct authority, path, and headers.
      // http/2 pseudo headers: :method, :path, :scheme, :authority
      const requestHeaders = getRequestHeaders(config, requestURL);

      const cancelSource = CancelToken.source();
      // TODO if existing config.token, combine it with this one.

      const pushResponsePromise = new Promise((resolve) => {
        serverResponse.createPushResponse(
          requestHeaders,
          (err, pushResponse) => {
            if (err) {
              // Can't reject the promise because nothing will catch() it.
              cancelSource.cancel('Push promise failed');
            } else {
              responsePool.add(pushResponse);

              pushResponse.on('close', () => {
                // The browser sent RST_STREAM requesting to cancel.
                // You can get Chrome to send this by refreshing the
                // view-source: page at least once; it refuses duplicate pushes.
                cancelSource.cancel('Push stream closed');
              });
              resolve(pushResponse);
            }
          }
        );
      });

      const newConfig = {
        ...config,
        responseType: 'stream',
        originalResponseType: config.responseType || 'json',
        // TODO transformResponse ?
        cancelToken: cancelSource.token,
        pushResponsePromise
      };

      // return targetAxios.request(newConfig).catch(err => emptyPromise());
      return targetAxios.request(newConfig).catch((err) => {
        console.warn('axios-push ignoring error', err); // TODO delete line
        return emptyPromise();
      });
    } else {
      // return an empty promise that never resolves.
      return emptyPromise(); // TODO refactor multiple returns
    }
  }

  if (!targetAxios.usingIsomorphicPushInterceptors) {
    targetAxios.interceptors.response.use(
      responseInterceptor,
      responseRejectedInterceptor
    );
    targetAxios.usingIsomorphicPushInterceptors = true;
  }

  function axiosWrapper(...params) {
    return interceptRequest(params, null, false);
  }

  axiosWrapper.request = (...params) =>
    interceptRequest(params, null, false);
  axiosWrapper.get = (...params) =>
    interceptRequest(params, 'get', false);
  axiosWrapper.delete = (...params) =>
    interceptRequest(params, 'delete', false);
  axiosWrapper.head = (...params) =>
    interceptRequest(params, 'head', false);
  axiosWrapper.post = (...params) =>
    interceptRequest(params, 'post', true);
  axiosWrapper.put = (...params) =>
    interceptRequest(params, 'put', true);
  axiosWrapper.patch = (...params) =>
    interceptRequest(params, 'patch', true);

  // others
  axiosWrapper.all = targetAxios.all;
  axiosWrapper.spread = targetAxios.spread;
  axiosWrapper.interceptors = targetAxios.interceptors;
  axiosWrapper.defaults = targetAxios.defaults;

  axiosWrapper.targetAxios = targetAxios;

  return axiosWrapper;
}
