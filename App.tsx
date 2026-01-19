import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Linking,
  Platform,
  RefreshControl,
  SafeAreaView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewNavigation } from 'react-native-webview';

const BASE_URL = 'https://maybe-someone-saw.vercel.app/';
const ALLOWED_HOSTS = ['maybe-someone-saw.vercel.app', 'open.spotify.com', 'spotify.com', 'accounts.spotify.com'];

const CLIENT_UPDATE_URL = `${BASE_URL.replace(/\/$/, '')}/api/client/update`;

type ClientUpdateInfo = {
  requiredVersion: string | null;
  apkUrl: string | null;
};

function normalizeTag(t: string) {
  const s = (t || '').trim();
  return s.startsWith('v') ? s : `v${s}`;
}

export default function App() {
  const webRef = useRef<WebView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [errorDetail, setErrorDetail] = useState('');

  const [checkingUpdate, setCheckingUpdate] = useState(true);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<ClientUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState('');
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  const clientSecret = useMemo(() => {
    const maybeExtra =
      (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ||
      ((Constants as any).expoGoConfig?.extra as Record<string, unknown> | undefined) ||
      ((Constants as any).manifest?.extra as Record<string, unknown> | undefined) ||
      ((Constants as any).manifest2?.extra as Record<string, unknown> | undefined) ||
      {};
    const extra = maybeExtra as Record<string, unknown>;
    return typeof extra.MV_CLIENT_SECRET === 'string' ? extra.MV_CLIENT_SECRET : '';
  }, []);

  const localReleaseTag = useMemo(() => {
    const maybeExtra =
      (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ||
      ((Constants as any).expoGoConfig?.extra as Record<string, unknown> | undefined) ||
      ((Constants as any).manifest?.extra as Record<string, unknown> | undefined) ||
      ((Constants as any).manifest2?.extra as Record<string, unknown> | undefined) ||
      {};
    const extra = maybeExtra as Record<string, unknown>;
    const t = typeof extra.RELEASE_TAG === 'string' ? extra.RELEASE_TAG : '';
    return t ? normalizeTag(t) : '';
  }, []);

  const fetchUpdateInfo = useCallback(async (): Promise<ClientUpdateInfo> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (clientSecret) headers['x-mv-client'] = clientSecret;
    const res = await fetch(CLIENT_UPDATE_URL, { headers });

    if (!res.ok) {
      throw new Error(`update_check_failed:${res.status}`);
    }

    const data = (await res.json()) as any;
    const requiredVersion = typeof data?.requiredVersion === 'string' ? normalizeTag(data.requiredVersion) : null;
    const apkUrl = typeof data?.apkUrl === 'string' ? String(data.apkUrl) : null;

    return { requiredVersion, apkUrl };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setCheckingUpdate(true);
        setUpdateError('');

        // If we don't have a local embedded tag (e.g., Expo Go / dev), don't block.
        if (!localReleaseTag) {
          if (!alive) return;
          setUpdateRequired(false);
          setCheckingUpdate(false);
          return;
        }

        const info = await fetchUpdateInfo();
        if (!alive) return;
        setUpdateInfo(info);

        const required = info?.requiredVersion ? normalizeTag(info.requiredVersion) : '';
        if (!required) {
          setUpdateRequired(false);
          return;
        }

        const needsUpdate = required !== localReleaseTag;
        setUpdateRequired(needsUpdate);
      } catch (e: any) {
        if (!alive) return;
        const msg = typeof e?.message === 'string' ? e.message : 'update_check_failed';
        // If we have a release tag baked into the app, update check must succeed.
        // Otherwise we can't guarantee freshness, so we block.
        setUpdateRequired(true);
        setUpdateError(msg);
      } finally {
        if (!alive) return;
        setCheckingUpdate(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchUpdateInfo, localReleaseTag]);

  const startUpdate = useCallback(async () => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (!updateInfo?.apkUrl) {
      setUpdateError('missing_apk_url');
      return;
    }

    setDownloadingUpdate(true);
    setUpdateError('');
    setDownloadProgress(0);

    try {
      const baseDir = (FileSystem as any).documentDirectory || (FileSystem as any).cacheDirectory || '';
      const out = `${baseDir}update-${localReleaseTag || 'latest'}.apk`;
      const dl = FileSystem.createDownloadResumable(
        updateInfo.apkUrl,
        out,
        {},
        (p: any) => {
          const total = typeof p?.totalBytesExpectedToWrite === 'number' ? p.totalBytesExpectedToWrite : 0;
          const written = typeof p?.totalBytesWritten === 'number' ? p.totalBytesWritten : 0;
          if (total > 0) setDownloadProgress(written / total);
        }
      );

      const result = await dl.downloadAsync();
      const uri = result?.uri || out;

      const contentUri = await FileSystem.getContentUriAsync(uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        flags: 1,
        type: 'application/vnd.android.package-archive'
      });
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : 'update_download_failed';
      setUpdateError(msg);
    } finally {
      setDownloadingUpdate(false);
    }
  }, [localReleaseTag, updateInfo]);

  const webSource = useMemo(() => {
    if (!clientSecret) return { uri: BASE_URL };
    return { uri: BASE_URL, headers: { 'x-mv-client': clientSecret } };
  }, [clientSecret]);

  const loadingPulse = useRef(new Animated.Value(0)).current;

  const baseHost = useMemo(() => {
    try {
      return new URL(BASE_URL).host;
    } catch {
      return '';
    }
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setHasError(false);
    setErrorDetail('');
    webRef.current?.reload();
    setTimeout(() => setRefreshing(false), 900);
  }, []);

  const retry = useCallback(() => {
    setHasError(false);
    setErrorDetail('');
    setLoading(true);
    webRef.current?.reload();
  }, []);

  const openExternal = useCallback(async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
    } catch {}
  }, []);

  const isExternalToBase = useCallback(
    (url: string) => {
      try {
        const u = new URL(url);
        if (ALLOWED_HOSTS.includes(u.host)) return false;
        if (baseHost && u.host === baseHost) return false;
        return true;
      } catch {
        return false;
      }
    },
    [baseHost]
  );

  const onShouldStartLoadWithRequest = useCallback(
    (req: any) => {
      const url = typeof req?.url === 'string' ? req.url : '';
      if (!url) return true;

      const isTopFrame = typeof req?.isTopFrame === 'boolean' ? req.isTopFrame : true;

      if (url.startsWith('spotify:') || url.startsWith('intent:')) {
        void openExternal(url);
        return false;
      }

      if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('sms:')) {
        void openExternal(url);
        return false;
      }

      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (isTopFrame) {
          try {
            const u = new URL(url);
            const host = u.host.toLowerCase();
            if ((host === 'open.spotify.com' || host === 'spotify.com') && !u.pathname.startsWith('/embed/')) {
              void openExternal(url);
              return false;
            }
          } catch {}
        }
        if (isTopFrame && isExternalToBase(url)) {
          void openExternal(url);
          return false;
        }
      }

      return true;
    },
    [isExternalToBase, openExternal]
  );

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    const url = typeof nav?.url === 'string' ? nav.url : '';
    if (!url) return;
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('sms:')) {
      void openExternal(url);
    }
  }, [openExternal]);

  useEffect(() => {
    if (!loading) {
      loadingPulse.stopAnimation();
      loadingPulse.setValue(0);
      return;
    }

    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(loadingPulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(loadingPulse, { toValue: 0, duration: 800, useNativeDriver: true })
      ])
    );

    anim.start();
    return () => anim.stop();
  }, [loading, loadingPulse]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      {checkingUpdate ? (
        <View style={styles.updateWrap}>
          <Text style={styles.updateTitle}>Checking update…</Text>
          <Text style={styles.updateBody}>Please wait.</Text>
          <ActivityIndicator size="small" color="#fbf1c7" style={{ marginTop: 14 }} />
          {updateError ? <Text style={styles.updateDetail}>{updateError}</Text> : null}
        </View>
      ) : updateRequired ? (
        <View style={styles.updateWrap}>
          <Text style={styles.updateTitle}>Update required</Text>
          <Text style={styles.updateBody}>A new version is available. You must update to continue.</Text>

          <View style={{ marginTop: 12, gap: 8 }}>
            <Text style={styles.updateMeta}>Current: {localReleaseTag}</Text>
            <Text style={styles.updateMeta}>Required: {updateInfo?.requiredVersion || ''}</Text>
          </View>

          {downloadingUpdate ? (
            <View style={{ marginTop: 16, width: '100%' }}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round(downloadProgress * 100)}%` }]} />
              </View>
              <Text style={styles.updateBody}>
                Downloading… {Math.round(downloadProgress * 100)}%
              </Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.updateBtn} onPress={() => void startUpdate()}>
              <Text style={styles.updateBtnText}>Download & Install</Text>
            </TouchableOpacity>
          )}

          {updateError ? <Text style={styles.updateDetail}>{updateError}</Text> : null}

          <TouchableOpacity
            style={styles.updateCancel}
            onPress={() => {
              BackHandler.exitApp();
            }}
          >
            <Text style={styles.updateCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {hasError ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorTitle}>Connection error</Text>
          <Text style={styles.errorBody}>We couldn’t load the site.</Text>
          {errorDetail ? <Text style={styles.errorDetail}>{errorDetail}</Text> : null}
          <TouchableOpacity style={styles.retryBtn} onPress={retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !checkingUpdate && !updateRequired ? (
        <View style={styles.webWrap}>
          <WebView
            ref={(r) => {
              webRef.current = r;
            }}
            style={styles.webView}
            source={webSource}
            onLoadStart={() => {
              setLoading(true);
              setHasError(false);
              setErrorDetail('');
            }}
            onLoadEnd={() => {
              setLoading(false);
              setRefreshing(false);
            }}
            onError={(e) => {
              const ne = (e as any)?.nativeEvent;
              const desc = typeof ne?.description === 'string' ? ne.description : '';
              const code = typeof ne?.code === 'number' ? String(ne.code) : '';
              const url = typeof ne?.url === 'string' ? ne.url : '';
              const parts = [code ? `code=${code}` : '', desc ? `desc=${desc}` : '', url ? `url=${url}` : ''].filter(Boolean);
              setErrorDetail(parts.join(' | '));
              setHasError(true);
              setLoading(false);
              setRefreshing(false);
            }}
            onHttpError={(e) => {
              const ne = (e as any)?.nativeEvent;
              const statusCode = typeof ne?.statusCode === 'number' ? String(ne.statusCode) : '';
              const url = typeof ne?.url === 'string' ? ne.url : '';
              const desc = typeof ne?.description === 'string' ? ne.description : '';
              const parts = [statusCode ? `http=${statusCode}` : '', desc ? `desc=${desc}` : '', url ? `url=${url}` : ''].filter(Boolean);
              setErrorDetail(parts.join(' | '));
              setHasError(true);
              setLoading(false);
              setRefreshing(false);
            }}
            startInLoadingState
            originWhitelist={['*']}
            pullToRefreshEnabled={Platform.OS === 'android'}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            onNavigationStateChange={onNavigationStateChange}
            allowsBackForwardNavigationGestures
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
          />

          {Platform.OS !== 'android' ? (
            <View style={styles.iosRefreshOverlay} pointerEvents="box-none">
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fbf1c7" />
            </View>
          ) : null}

          {loading ? (
            <View style={styles.loadingOverlay} pointerEvents="none">
              <Animated.View
                style={[
                  styles.loadingCard,
                  {
                    opacity: loadingPulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }),
                    transform: [
                      {
                        scale: loadingPulse.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] })
                      }
                    ]
                  }
                ]}
              >
                <View style={styles.brandMark}>
                  <Text style={styles.brandMarkText}>N</Text>
                </View>
                <Text style={styles.loadingTitle}>Nen&apos;s Memories</Text>
                <Text style={styles.loadingSubtitle}>Opening your notes…</Text>
                <View style={styles.loadingSpinnerRow}>
                  <ActivityIndicator size="small" color="#fbf1c7" />
                  <Text style={styles.loadingSpinnerText}>Loading</Text>
                </View>
              </Animated.View>
            </View>
          ) : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#1d2021'
  },
  webWrap: {
    flex: 1,
    backgroundColor: '#1d2021'
  },
  webView: {
    backgroundColor: '#1d2021'
  },
  loadingOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1d2021'
  },
  loadingCard: {
    width: '82%',
    maxWidth: 420,
    borderRadius: 22,
    paddingVertical: 18,
    paddingHorizontal: 18,
    backgroundColor: 'rgba(40,40,40,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(251,241,199,0.12)',
    alignItems: 'center'
  },
  brandMark: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: 'rgba(251,241,199,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(251,241,199,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10
  },
  brandMarkText: {
    color: '#fbf1c7',
    fontWeight: '800',
    fontSize: 22
  },
  loadingTitle: {
    color: '#fbf1c7',
    fontWeight: '700',
    fontSize: 18,
    marginBottom: 4
  },
  loadingSubtitle: {
    color: '#bdae93',
    fontSize: 13,
    marginBottom: 14
  },
  loadingSpinnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  loadingSpinnerText: {
    color: '#fbf1c7',
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.9
  },
  errorWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  },
  updateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#1d2021'
  },
  updateTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fbf1c7',
    marginBottom: 8
  },
  updateBody: {
    fontSize: 13,
    color: '#a89984',
    textAlign: 'center'
  },
  updateMeta: {
    fontSize: 12,
    color: '#bdae93',
    textAlign: 'center'
  },
  updateDetail: {
    marginTop: 10,
    fontSize: 12,
    color: '#ffb4b4',
    textAlign: 'center'
  },
  updateBtn: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(60,56,54,0.75)'
  },
  updateBtnText: {
    color: '#fbf1c7',
    fontWeight: '700'
  },
  updateCancel: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(40,40,40,0.62)'
  },
  updateCancelText: {
    color: '#a89984',
    fontWeight: '600'
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(60,56,54,0.75)',
    overflow: 'hidden'
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#458588'
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fbf1c7',
    marginBottom: 8
  },
  errorBody: {
    fontSize: 13,
    color: '#a89984',
    marginBottom: 14
  },
  errorDetail: {
    fontSize: 12,
    color: '#bdae93',
    marginBottom: 14
  },
  retryBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(60,56,54,0.75)'
  },
  retryText: {
    color: '#fbf1c7',
    fontWeight: '600'
  },
  iosRefreshOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 0
  }
});
