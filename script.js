/* ====================================================
   「ひろしまの和」実際の行政区域境界 (Leaflet & GeoJSON) マップロジック
   ==================================================== */

// Firebase Modular SDK のインポート (CDN経由)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { 
  getFirestore, collection, addDoc, doc, deleteDoc, onSnapshot, serverTimestamp, query, orderBy, writeBatch 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ----------------------------------------------------
// Firebase 設定欄
// ----------------------------------------------------
// ⚠️ 本番運用時はご自身の Firebase コンソールから取得したConfigに書き換えてください。
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// ----------------------------------------------------
// 1. グローバル状態・Leaflet 地図管理・DB状態
// ----------------------------------------------------
let map = null;
let geojsonLayer = null;
let activeMode = 'municipality'; // 'municipality' または 'ward'

let appData = {
  municipality: {}, // 市町村モードデータ
  ward: {}          // 広島市区モードデータ
};

// キャッシュ用GeoJSONデータ
let muniGeoJsonData = null;
let wardGeoJsonData = null;

// Firebase Firestore 関連グローバル変数
let db = null;
let isDbMode = false; // Firestoreが正常接続できているかどうか
let unsubscribeFirestore = null;

// 登録可能な地域リスト (プルダウン動的生成およびマッピング検証用)
const REGION_LIST = {
  municipality: [
    "安芸太田町", "安芸高田市", "江田島市", "大崎上島町", "大竹市", "尾道市", 
    "海田町", "北広島町", "熊野町", "呉市", "坂町", "庄原市", "神石高原町", 
    "世羅町", "竹原市", "廿日市市", "東広島市", "広島市", "福山市", "府中市", 
    "府中町", "三原市", "三次市"
  ],
  ward: [
    "安芸区", "安佐北区", "安佐南区", "佐伯区", "中区", "西区", "東区", "南区"
  ]
};

// ----------------------------------------------------
// 2. アプリ初期化 (CORSや読み込みエラーに対応した fetch 処理)
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // Leaflet 地図インスタンスの初期化
  initMap();

  // 広島市選択時の区追加プルダウン連動
  const hometownSelect = document.getElementById('hometown-select');
  const wardSelectContainer = document.getElementById('wardSelectContainer');
  const wardSelect = document.getElementById('wardSelect');

  hometownSelect.addEventListener('change', () => {
    if (activeMode === 'municipality' && hometownSelect.value === '広島市') {
      wardSelectContainer.style.display = 'block';
    } else {
      wardSelectContainer.style.display = 'none';
      wardSelect.value = '';
    }
  });

  // 共有DB接続状態の初期表示を "checking" (確認中) に設定
  updateDbStatus("checking");

  // Firebase設定が完了しているかどうかの判定
  const isFirebaseConfigured = 
    firebaseConfig.apiKey && 
    firebaseConfig.apiKey !== "YOUR_API_KEY" && 
    firebaseConfig.projectId && 
    firebaseConfig.projectId !== "YOUR_PROJECT_ID";

  if (!isFirebaseConfigured) {
    console.log("Firebase config is not set. Running in localStorage mode.");
    isDbMode = false;
    updateDbStatus("unconfigured");
    
    // GeoJSONをフェッチして localStorage からデータをロード
    fetchGeoJsonAndLoadData(false);
  } else {
    // Firebase を初期化して Firestore へ接続試行
    try {
      const app = initializeApp(firebaseConfig);
      db = getFirestore(app);
      
      // 接続に成功した前提で、リアルタイム監視を開始
      const q = query(collection(db, "residents"), orderBy("createdAt", "asc"));
      unsubscribeFirestore = onSnapshot(q, (snapshot) => {
        // 接続完了ステータスに変更
        isDbMode = true;
        updateDbStatus("connected");

        // 共有DBから受け取ったデータで appData を完全に再構築
        appData = { municipality: {}, ward: {} };

        snapshot.forEach((doc) => {
          const data = doc.data();
          const id = doc.id;
          const mode = data.mode || "municipality";

          const region = data.region;
          const ward = data.ward || "";
          const name = data.name;
          // 新規追加直後の serverTimestamp は非同期反映まで null なので現在時刻でフォールバック
          const createdAt = data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString();

          if (region) {
            if (!appData[mode][region]) {
              appData[mode][region] = [];
            }
            appData[mode][region].push({
              id: id, // FirestoreのドキュメントIDを保持
              name: name,
              ward: ward,
              createdAt: createdAt
            });
          }
        });

        // UIとマップを再描画
        updateUI();
      }, (error) => {
        console.error("Firestore connection failed, falling back to localStorage.", error);
        isDbMode = false;
        updateDbStatus("error");
        
        // エラー発生時は localStorage モードへフォールバック
        fetchGeoJsonAndLoadData(true);
      });

      // GeoJSON データのフェッチのみを先行して実行
      fetchGeoJsonOnly();
    } catch (e) {
      console.error("Firebase init failed, falling back to localStorage.", e);
      isDbMode = false;
      updateDbStatus("error");
      fetchGeoJsonAndLoadData(true);
    }
  }
});

// GeoJSONをフェッチし、localStorage データをロードする（フォールバック時）
function fetchGeoJsonAndLoadData(isFallback) {
  Promise.all([
    fetch('./data/hiroshima_municipalities.geojson').then(res => {
      if (!res.ok) throw new Error("hiroshima_municipalities.geojson の読み込みに失敗しました。");
      return res.json();
    }),
    fetch('./data/hiroshima_wards.geojson').then(res => {
      if (!res.ok) throw new Error("hiroshima_wards.geojson の読み込みに失敗しました。");
      return res.json();
    })
  ]).then(([muniData, wardData]) => {
    muniGeoJsonData = muniData;
    wardGeoJsonData = wardData;

    // localStorageから全データをロード
    loadAllData();
    
    // 初期UIの描画
    initFormSelect();
    updateUI();
  }).catch(err => {
    console.error("GeoJSON Load Error:", err);
    showMapError(
      "地図データの読み込みに失敗しました。dataフォルダ内のGeoJSONファイルのパスを確認してください。",
      "【原因の可能性】ローカル環境で index.html を直接ダブルクリックして開いている場合、ブラウザのセキュリティ制限（CORS）によって GeoJSON の fetch が拒否されます。README.md を参考に、簡易Webサーバーを起動してアクセスしてください。"
    );
    loadAllData();
    initFormSelect();
  });
}

// 共有DB用の GeoJSON フェッチのみ（データは onSnapshot がロードするため、地図境界データだけを準備）
function fetchGeoJsonOnly() {
  Promise.all([
    fetch('./data/hiroshima_municipalities.geojson').then(res => {
      if (!res.ok) throw new Error("hiroshima_municipalities.geojson の読み込みに失敗しました。");
      return res.json();
    }),
    fetch('./data/hiroshima_wards.geojson').then(res => {
      if (!res.ok) throw new Error("hiroshima_wards.geojson の読み込みに失敗しました。");
      return res.json();
    })
  ]).then(([muniData, wardData]) => {
    muniGeoJsonData = muniData;
    wardGeoJsonData = wardData;
    
    // プルダウン等の初期化
    initFormSelect();
    // もしすでに onSnapshot が完了していれば、UIを一度描画
    updateUI();
  }).catch(err => {
    console.error("GeoJSON Load Error (DB Mode):", err);
    showMapError(
      "地図データの読み込みに失敗しました。",
      "ブラウザのセキュリティ制限（CORS）またはパス設定を確認してください。"
    );
    initFormSelect();
  });
}

// 共有DB接続状態のバッジUI更新
function updateDbStatus(status) {
  const box = document.getElementById('db-status-box');
  const icon = document.getElementById('db-status-icon');
  const text = document.getElementById('db-status-text');

  if (!box || !icon || !text) return;

  box.className = 'db-status-box'; // リセット
  
  if (status === 'checking') {
    box.classList.add('checking');
    icon.className = 'fa-solid fa-spinner fa-spin';
    text.textContent = '共有DB接続状態を確認中...';
  } else if (status === 'connected') {
    box.classList.add('connected');
    icon.className = 'fa-solid fa-cloud';
    icon.classList.remove('fa-spin');
    text.textContent = '共有DB接続済み';
  } else if (status === 'unconfigured') {
    box.classList.add('unconfigured');
    icon.className = 'fa-solid fa-cloud-slash';
    text.textContent = 'Firebase設定が未完了です。現在はローカル保存モードで動作しています。';
  } else if (status === 'error' || status === 'fallback') {
    box.classList.add('error');
    icon.className = 'fa-solid fa-triangle-exclamation';
    text.textContent = '共有DB接続失敗：ローカル保存モード';
  }
}


// ----------------------------------------------------
// 3. Leaflet マップ初期化
// ----------------------------------------------------
function initMap() {
  // コンテナID 'map' に地図を生成。無地背景にするためタイルレイヤーはロードしません
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    minZoom: 7,
    maxZoom: 13,
    dragging: true,
    scrollWheelZoom: true
  });

  // 初期位置を広島県の中央付近にセット (GeoJSONロード時に自動的に fitBounds されます)
  map.setView([34.3963, 132.4594], 9);
}

// ----------------------------------------------------
// 4. 入力フォームの動的プルダウン生成
// ----------------------------------------------------
function initFormSelect() {
  const select = document.getElementById('hometown-select');
  const label = document.getElementById('select-label');
  const formTitle = document.getElementById('form-title');
  const wardSelect = document.getElementById('wardSelect');
  const wardSelectContainer = document.getElementById('wardSelectContainer');
  
  select.innerHTML = '';

  // 広島市の区プルダウンの動的生成
  if (wardSelect) {
    wardSelect.innerHTML = '';
    const defaultWardOption = document.createElement('option');
    defaultWardOption.value = "";
    defaultWardOption.disabled = true;
    defaultWardOption.selected = true;
    defaultWardOption.hidden = true;
    defaultWardOption.textContent = "区を選択してください";
    wardSelect.appendChild(defaultWardOption);

    REGION_LIST.ward.forEach(ward => {
      const opt = document.createElement('option');
      opt.value = ward;
      opt.textContent = ward;
      wardSelect.appendChild(opt);
    });
  }

  // 初期時は区選択欄を非表示にしてリセット
  if (wardSelectContainer) wardSelectContainer.style.display = 'none';
  if (wardSelect) wardSelect.value = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = "";
  defaultOption.disabled = true;
  defaultOption.selected = true;
  defaultOption.hidden = true;

  if (activeMode === 'municipality') {
    label.textContent = "住んでいる市・町";
    formTitle.textContent = "市町村モードで登録";
    defaultOption.textContent = "市・町を選択してください";
    select.appendChild(defaultOption);

    // 市町村リストを順次追加
    REGION_LIST.municipality.forEach(city => {
      const opt = document.createElement('option');
      opt.value = city;
      opt.textContent = city;
      select.appendChild(opt);
    });
  } else {
    label.textContent = "住んでいる区（広島市）";
    formTitle.textContent = "広島市区モードで登録";
    defaultOption.textContent = "区を選択してください";
    select.appendChild(defaultOption);

    // 広島市8区を順次追加
    REGION_LIST.ward.forEach(ward => {
      const opt = document.createElement('option');
      opt.value = ward;
      opt.textContent = ward;
      select.appendChild(opt);
    });
  }
}

// ----------------------------------------------------
// 5. モード切り替え
// ----------------------------------------------------
function switchMode(mode) {
  if (activeMode === mode) return;
  activeMode = mode;

  // タブボタンのアクティブクラス切り替え
  document.getElementById('btn-mode-municipality').classList.toggle('active', mode === 'municipality');
  document.getElementById('btn-mode-ward').classList.toggle('active', mode === 'ward');

  // ポップアップを閉じる
  map.closePopup();

  // 区選択コンテナのクリアと非表示
  const wardSelectContainer = document.getElementById('wardSelectContainer');
  const wardSelect = document.getElementById('wardSelect');
  if (wardSelectContainer) wardSelectContainer.style.display = 'none';
  if (wardSelect) wardSelect.value = '';

  // フォーム・UIリスト・地図塗り分けの更新
  initFormSelect();
  updateUI();
  
  showToast(`${mode === 'municipality' ? '市町村' : '広島市区'}モードに切り替えました。`, 'success');
}

// ----------------------------------------------------
// 6. コロプレスマップの塗り分け & インタラクション (Leaflet)
// ----------------------------------------------------

// 人数に応じた塗り分けカラーコードを返す (0人:暗いグレー ➔ 1人:薄青 ➔ 2〜3人:中青 ➔ 4人+:濃青)
function getChoroplethColor(count) {
  if (!count || count === 0) {
    return '#1e293b'; // 0人: 暗いグレー
  }
  if (count === 1) {
    return 'rgba(56, 189, 248, 0.45)'; // 1人: 薄い青 (var(--c1-blue-light))
  }
  if (count <= 3) {
    return 'rgba(14, 165, 233, 0.72)'; // 2〜3人: 中くらいの青 (var(--c2-blue-medium))
  }
  return 'rgba(2, 132, 199, 0.95)'; // 4人以上: 濃い青 (var(--c3-blue-dark))
}

// 各フィーチャーのスタイル決定
function getFeatureStyle(feature) {
  const regionName = feature.properties.name;
  const currentData = appData[activeMode];
  const names = currentData[regionName] || [];
  const count = names.length;

  return {
    fillColor: getChoroplethColor(count),
    weight: 2,
    opacity: 1,
    color: '#0f172a', // 境界線は深いスレートネイビー
    fillOpacity: 0.85
  };
}

// 各フィーチャー（ポリゴン）へのインタラクションバインド
function onEachFeature(feature, layer) {
  const regionName = feature.properties.name;

  // A. ホバーツールチップによる地域名表示 (恒常表示ではなく、ホバー時にすっきり出す)
  layer.bindTooltip(regionName, {
    permanent: false,
    direction: 'center',
    className: 'leaflet-tooltip-own'
  });

  layer.on({
    // B. ホバー開始：境界線の黄色ハイライト＆左側リストとの強調連動
    mouseover: (e) => {
      const targetLayer = e.target;
      targetLayer.setStyle({
        color: '#facc15', // イエローで境界線をハイライト
        weight: 3.5,
        fillOpacity: 0.95
      });

      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        targetLayer.bringToFront();
      }

      // 左側リストのハイライト連動
      const listItem = document.getElementById(`item-${regionName}`);
      if (listItem) {
        listItem.classList.add('highlight-active');
      }
    },

    // C. ホバー終了：ハイライト解除
    mouseout: (e) => {
      if (geojsonLayer) {
        geojsonLayer.resetStyle(e.target);
      }
      
      // 左側リストのハイライト解除
      const listItem = document.getElementById(`item-${regionName}`);
      if (listItem) {
        listItem.classList.remove('highlight-active');
      }
    },

    // D. クリック：指定形式に完全に準拠した Leaflet ポップアップの表示
    click: (e) => {
      const currentData = appData[activeMode];
      const names = currentData[regionName] || [];
      const count = names.length;

      // ユーザー指定の表示形式に完全準拠した HTML
      let popupHTML = `
        <div class="popup-content" style="color: #f8fafc; font-family: 'Noto Sans JP', sans-serif;">
          <h3 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; font-weight: 700; color: #facc15; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.25rem;">
            ${regionName}
          </h3>
          <div style="font-size: 0.8rem; font-weight: bold; margin-bottom: 0.4rem; color: #94a3b8;">
            登録人数：${count}人
          </div>
      `;

      if (count > 0) {
        popupHTML += `
          <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.25rem;">登録者：</div>
          <ol style="margin: 0; padding-left: 1.15rem; font-size: 0.8rem; max-height: 120px; overflow-y: auto; color: #f8fafc;">
            ${names.map(nameObj => {
              const name = (typeof nameObj === 'object') ? nameObj.name : nameObj;
              const ward = (typeof nameObj === 'object') ? nameObj.ward : "";
              const wardLabel = (activeMode === 'municipality' && regionName === '広島市') ? (ward ? `（${ward}）` : '（区未入力）') : "";
              return `<li>${escapeHtml(name)}${escapeHtml(wardLabel)}</li>`;
            }).join('')}
          </ol>
        `;
      } else {
        popupHTML += `<p style="margin: 0; font-size: 0.75rem; color: #94a3b8; text-align: center; padding: 0.3rem 0;">登録データはありません。</p>`;
      }
      popupHTML += `</div>`;

      layer.bindPopup(popupHTML, {
        closeButton: false,
        offset: L.point(0, -5)
      }).openPopup();

      // 左側アコーディオンリストの連動展開＆スクロール
      if (count > 0) {
        toggleAccordion(regionName, true);
        setTimeout(() => {
          const listItem = document.getElementById(`item-${regionName}`);
          if (listItem) {
            listItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 150);
      }
    }
  });
}

// 地図レイヤーの描画・更新
function updateMapVisuals() {
  if (!map) return;

  // すでにレイヤーが展開されている場合は削除
  if (geojsonLayer) {
    map.removeLayer(geojsonLayer);
  }

  const geoData = activeMode === 'municipality' ? muniGeoJsonData : wardGeoJsonData;
  if (!geoData) return;

  // GeoJSON レイヤーをマップに追加
  geojsonLayer = L.geoJSON(geoData, {
    style: getFeatureStyle,
    onEachFeature: onEachFeature
  }).addTo(map);

  // 地図の表示範囲（境界）を、行政区域全体にピッタリとフィットさせる (fitBounds)
  try {
    map.fitBounds(geojsonLayer.getBounds(), {
      padding: [30, 30] // 画面端に適度な余白を設定
    });
  } catch (e) {
    console.error("fitBounds failed:", e);
  }
}

// 左側リストホバー連動用：リスト上のホバーで対応する Leaflet ポリゴンをハイライト
function highlightMapRegion(regionName, active) {
  if (!geojsonLayer) return;

  geojsonLayer.eachLayer(layer => {
    if (layer.feature.properties.name === regionName) {
      if (active) {
        layer.setStyle({
          color: '#facc15',
          weight: 3.5,
          fillOpacity: 0.95
        });
        if (!L.Browser.ie && !L.Browser.opera) {
          layer.bringToFront();
        }
      } else {
        geojsonLayer.resetStyle(layer);
      }
    }
  });
}

// ----------------------------------------------------
// 7. データ操作 (CRUD)
// ----------------------------------------------------

// 新規メンバー登録
async function handleAddUser() {
  const nameInput = document.getElementById('username');
  const select = document.getElementById('hometown-select');

  const name = nameInput.value.trim();
  const region = select.value;

  if (!name) {
    showToast('お名前を入力してください。', 'error');
    return;
  }
  if (!region) {
    showToast('地域を選択してください。', 'error');
    return;
  }

  // 広島市選択時の区選択バリデーション
  let ward = "";
  if (activeMode === 'municipality' && region === '広島市') {
    const wardSelect = document.getElementById('wardSelect');
    ward = wardSelect ? wardSelect.value : "";
    if (!ward) {
      showToast('広島市を選択した場合は、区も選択してください。', 'error');
      return;
    }
  }

  if (isDbMode) {
    // 共有データベース (Firestore) 保存モード
    try {
      await addDoc(collection(db, "residents"), {
        name: name,
        region: region,
        ward: ward,
        mode: activeMode,
        createdAt: serverTimestamp()
      });
      showToast(`${name}さんを「${region}${ward ? ' ' + ward : ''}」に登録しました！`, 'success');
      
      // お名前入力欄のみクリアしフォーカス
      nameInput.value = '';
      nameInput.focus();

      // 登録した地域を自動的にハイライト＆フォーカス表示
      setTimeout(() => {
        focusOnMapRegion(region);
      }, 400);
    } catch (error) {
      console.error("Firestore Add Error:", error);
      showToast('共有DBへの追加に失敗しました。ローカル保存モードへの自動切替を行います。', 'error');
      // エラー発生時はフォールバック
      isDbMode = false;
      updateDbStatus("error");
    }
  } else {
    // 従来のローカル保存モード (localStorage)
    if (!appData[activeMode][region]) {
      appData[activeMode][region] = [];
    }

    const userObj = {
      name: name,
      ward: ward,
      createdAt: new Date().toISOString()
    };
    appData[activeMode][region].push(userObj);

    // 保存とUI・地図更新
    saveCurrentData();
    updateUI();
    showToast(`${name}さんを「${region}${ward ? ' ' + ward : ''}」に登録しました！`, 'success');

    // お名前入力欄のみクリアしフォーカス
    nameInput.value = '';
    nameInput.focus();

    // 登録した地域を自動的にハイライト＆フォーカス表示
    setTimeout(() => {
      focusOnMapRegion(region);
    }, 400);
  }
}

// 個別名前削除
async function deleteUser(region, index) {
  const currentData = appData[activeMode];
  if (!currentData[region]) return;

  const deletedName = currentData[region][index];
  const deletedNameStr = (typeof deletedName === 'object') ? deletedName.name : deletedName;
  
  if (isDbMode && typeof deletedName === 'object' && deletedName.id) {
    // 共有データベース (Firestore) 削除モード
    try {
      await deleteDoc(doc(db, "residents", deletedName.id));
      showToast(`${deletedNameStr}さんのデータを削除しました。`, 'success');
      map.closePopup();
    } catch (error) {
      console.error("Firestore Delete Error:", error);
      showToast('共有DBからの削除に失敗しました。', 'error');
    }
  } else {
    // 従来のローカル保存モード (localStorage)
    currentData[region].splice(index, 1);

    // 地域に誰もいなくなったらキーを消去
    if (currentData[region].length === 0) {
      delete currentData[region];
    }

    saveCurrentData();
    updateUI();
    showToast(`${deletedNameStr}さんのデータを削除しました。`, 'success');
    map.closePopup();
  }
}

// 全データクリア (三者択一制御)
async function confirmClearAll() {
  const currentData = appData[activeMode];
  const total = Object.values(currentData).reduce((sum, names) => sum + names.length, 0);

  // 全モードの合計件数も算出しておく
  const totalAllModes = 
    Object.values(appData.municipality).reduce((sum, names) => sum + names.length, 0) +
    Object.values(appData.ward).reduce((sum, names) => sum + names.length, 0);

  const checkTotal = isDbMode ? totalAllModes : total;
  if (checkTotal === 0) {
    showToast('削除するデータがありません。', 'error');
    return;
  }

  const choice = prompt(
    "【全データ一括削除オプション】\n\n" +
    "現在のモードのデータをすべて削除する場合は 「1」 を入力してください。\n" +
    "すべてのモードのデータを完全に削除する場合は 「2」 を入力してください。\n" +
    "キャンセルする場合は、このまま「キャンセル」を押すか空白にしてください。"
  );

  if (!choice) {
    showToast('削除をキャンセルしました。', 'success');
    return;
  }

  if (choice !== '1' && choice !== '2') {
    showToast('無効な数値です。削除をキャンセルしました。', 'error');
    return;
  }

  const confirmMsg = choice === '1' 
    ? `【警告】本当に現在のモードの全データ（${total}名分）を削除しますか？`
    : `【警告】本当に全モードのすべてのデータ（${totalAllModes}名分）を完全に削除しますか？\n（※この操作は取り消せません）`;

  if (!confirm(confirmMsg)) {
    showToast('削除をキャンセルしました。', 'success');
    return;
  }

  if (isDbMode) {
    // 共有データベース (Firestore) バッチ削除モード
    try {
      const batch = writeBatch(db);
      let count = 0;
      const modesToDelete = choice === '1' ? [activeMode] : ['municipality', 'ward'];

      modesToDelete.forEach(m => {
        Object.values(appData[m]).forEach(users => {
          users.forEach(user => {
            if (user.id) {
              const ref = doc(db, "residents", user.id);
              batch.delete(ref);
              count++;
            }
          });
        });
      });

      if (count > 0) {
        await batch.commit();
        showToast(`${count}件のデータを共有DBから削除しました。`, 'success');
        map.closePopup();
      } else {
        showToast('削除対象のデータがありませんでした。', 'error');
      }
    } catch (error) {
      console.error("Firestore Clear Error:", error);
      showToast('共有DBの一括削除に失敗しました。', 'error');
    }
  } else {
    // 従来のローカル保存モード (localStorage)
    if (choice === '1') {
      appData[activeMode] = {};
      showToast('現在のモードのデータをすべてクリアしました。', 'success');
    } else {
      appData.municipality = {};
      appData.ward = {};
      showToast('すべてのモードのデータを完全にクリアしました。', 'success');
    }
    
    saveCurrentData();
    updateUI();
    map.closePopup();
  }
}

// ----------------------------------------------------
// 8. localStorage 連携 & 将来的な共有データベース化について
// ----------------------------------------------------

/* 
  【💡 開発者へのメッセージ：複数ユーザーでのデータ共有に向けて】
  現在は、全登録データが各ユーザー個人のブラウザ（localStorage）にのみ保存されます。
  そのため、Aさんが登録した内容がBさんの画面には共有されません。

  将来的に「全員の登録データをリアルタイムに1つの地図に集計して共有したい」場合は、
  以下の手順でバックエンドのデータベースと連携してください：
  
  1. 保存処理（saveCurrentData）の書き換え：
     - localStorage.setItem の代わりに、Firebase Realtime Database / Supabase / Google Sheets API などの
       エンドポイントに非同期POSTリクエストを送信し、クラウド上にデータを永続保存します。
       例：
       async function saveCurrentDataOnline(region, username) {
         await fetch('https://YOUR_BACKEND_API/register', {
           method: 'POST',
           body: JSON.stringify({ mode: activeMode, region: region, name: username })
         });
       }

  2. 読み込み処理（loadAllData / updateUI）の書き換え：
     - アプリ起動時に、クラウド上のAPIエンドポイントから登録データ一覧をGETリクエストで取得し、
       `appData` を動的に構築してから `updateUI()` を実行します。
       例：
       async function loadAllDataOnline() {
         const res = await fetch('https://YOUR_BACKEND_API/data');
         appData = await res.json();
         updateUI();
       }
*/

function saveCurrentData() {
  localStorage.setItem('hiroshima_geojson_app_data', JSON.stringify(appData));
}

// 独立した localStorage からデータをロード
function loadAllData() {
  // 不要となった古い同意確認フラグを完全に削除・クリーンアップ
  localStorage.removeItem('privacyConsentConfirmed');

  const stored = localStorage.getItem('hiroshima_geojson_app_data');

  if (stored) {
    try {
      appData = JSON.parse(stored);
      if (!appData.municipality) appData.municipality = {};
      if (!appData.ward) appData.ward = {};
    } catch (e) {
      console.error(e);
      appData = { municipality: {}, ward: {} };
    }
  } else {
    // デモ用初期データ (オブジェクト形式に合わせて定義)
    appData = {
      municipality: {
        "福山市": [
          { name: "山田太郎", ward: "", createdAt: new Date().toISOString() },
          { name: "佐藤花子", ward: "", createdAt: new Date().toISOString() }
        ],
        "呉市": [
          { name: "鈴木一郎", ward: "", createdAt: new Date().toISOString() }
        ],
        "東広島市": [
          { name: "藤川幸二", ward: "", createdAt: new Date().toISOString() }
        ],
        "三次市": [
          { name: "永川勝浩", ward: "", createdAt: new Date().toISOString() }
        ],
        "廿日市市": [
          { name: "中島浩平", ward: "", createdAt: new Date().toISOString() }
        ]
      },
      ward: {
        "中区": [
          { name: "田中花子", ward: "", createdAt: new Date().toISOString() }
        ],
        "安佐南区": [
          { name: "高橋太郎", ward: "", createdAt: new Date().toISOString() }
        ]
      }
    };
    saveCurrentData();
  }
}

// ----------------------------------------------------
// 9. 左側UIリストの更新 (人数の多い順ソート、アコーディオン機能)
// ----------------------------------------------------
function updateUI() {
  const currentData = appData[activeMode];
  
  // 総登録者数の算出と表示
  const total = Object.values(currentData).reduce((sum, names) => sum + names.length, 0);
  document.getElementById('total-count').textContent = total;

  const listContainer = document.getElementById('list-container');

  if (total === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <i class="fa-regular fa-map empty-icon"></i>
        <span>登録データはありません。上のフォームから登録してみましょう！</span>
      </div>
    `;
    updateMapVisuals(); 
    return;
  }

  // 人数順（降順）にソート
  const sortedList = Object.entries(currentData)
    .map(([place, names]) => ({ place, names, count: names.length }))
    .sort((a, b) => b.count - a.count);

  let listHTML = '<ul class="location-list">';

  sortedList.forEach(({ place, names, count }) => {
    listHTML += `
      <li class="location-item" id="item-${escapeHtml(place)}" 
          onmouseover="highlightMapRegion('${escapeHtml(place)}', true)" 
          onmouseout="highlightMapRegion('${escapeHtml(place)}', false)">
        <div class="location-header" onclick="toggleAccordion('${escapeHtml(place)}')">
          <div class="location-name-group">
            <span style="font-weight: 700; font-size: 0.9rem;">${escapeHtml(place)}</span>
            <span class="location-count-badge" style="margin-left: 0.5rem;">${count}人</span>
          </div>
          <div>
            <i class="fa-solid fa-chevron-down chevron-icon"></i>
          </div>
        </div>
        <div class="names-collapse">
          <ul class="names-list">
            ${names.map((nameObj, idx) => {
              const name = (typeof nameObj === 'object') ? nameObj.name : nameObj;
              const ward = (typeof nameObj === 'object') ? nameObj.ward : "";
              const wardLabel = (activeMode === 'municipality' && place === '広島市') ? (ward ? `（${ward}）` : '（区未入力）') : "";
              return `
              <li class="name-item">
                <span class="name-label">
                  <span class="name-number">${idx + 1}.</span>
                  <span>${escapeHtml(name)}${escapeHtml(wardLabel)}</span>
                </span>
                <button class="delete-btn" onclick="event.stopPropagation(); deleteUser('${escapeHtml(place)}', ${idx})" title="この登録を削除">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </li>
              `;
            }).join('')}
            <li style="padding-top: 0.25rem;">
              <button class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" onclick="event.stopPropagation(); focusOnMapRegion('${escapeHtml(place)}')">
                <i class="fa-solid fa-eye"></i> マップで表示
              </button>
            </li>
          </ul>
        </div>
      </li>
    `;
  });

  listHTML += '</ul>';
  listContainer.innerHTML = listHTML;

  // 地図の塗り分けとラベル表示の更新
  updateMapVisuals();
}

// リストのアコーディオン開閉
function toggleAccordion(place, forceOpen = false) {
  const item = document.getElementById(`item-${place}`);
  if (!item) return;

  const isActive = item.classList.contains('active');
  
  document.querySelectorAll('.location-item').forEach(el => {
    el.classList.remove('active');
  });

  if (forceOpen || !isActive) {
    item.classList.add('active');
  }
}

// リストの「マップで表示」を押した際、該当ポリゴンをフォーカスズームしポップアップを自動起動
function focusOnMapRegion(place) {
  if (!geojsonLayer) return;

  geojsonLayer.eachLayer(layer => {
    if (layer.feature.properties.name === place) {
      // ズーム・表示移動
      map.setView(layer.getBounds().getCenter(), activeMode === 'municipality' ? 10 : 12);
      
      // ポップアップを開く
      layer.fire('click');
    }
  });

  // スマホの場合はマップへ自動スクロール
  if (window.innerWidth <= 768) {
    const mapArea = document.querySelector('.map-area');
    if (mapArea) {
      mapArea.scrollIntoView({ behavior: 'smooth' });
    }
  }
}

// ----------------------------------------------------
// 10. CSVエクスポート機能 (BOM付き)
// ----------------------------------------------------
function exportToCSV() {
  let csvContent = 'mode,region,ward,name,createdAt\n';
  let hasData = false;

  ['municipality', 'ward'].forEach(mode => {
    const modeData = appData[mode];
    Object.entries(modeData).forEach(([region, names]) => {
      names.forEach(nameObj => {
        hasData = true;
        const name = (typeof nameObj === 'object') ? nameObj.name : nameObj;
        const ward = (typeof nameObj === 'object') ? nameObj.ward : "";
        const createdAt = (typeof nameObj === 'object') ? (nameObj.createdAt || "") : "";

        const safeMode = `"${mode}"`;
        const safeRegion = `"${region.replace(/"/g, '""')}"`;
        const safeWard = `"${ward.replace(/"/g, '""')}"`;
        const safeName = `"${name.replace(/"/g, '""')}"`;
        const safeCreatedAt = `"${createdAt.replace(/"/g, '""')}"`;

        csvContent += `${safeMode},${safeRegion},${safeWard},${safeName},${safeCreatedAt}\n`;
      });
    });
  });

  if (!hasData) {
    showToast('出力するデータがありません。', 'error');
    return;
  }

  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
  
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  
  link.setAttribute('href', url);
  link.setAttribute('download', `hiroshima_geojson_all_${dateStr}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('CSVファイルをエクスポートしました。', 'success');
}

// ----------------------------------------------------
// 11. ユーティリティ & トースト
// ----------------------------------------------------

// HTMLエスケープ
function escapeHtml(string) {
  if (typeof string !== 'string') return string;
  return string.replace(/[&<>"']/g, function(match) {
    const escapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;'
    };
    return escapeMap[match];
  });
}

// トースト通知
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastIcon = document.getElementById('toast-icon');
  const toastMessage = document.getElementById('toast-message');

  toastMessage.textContent = message;

  toast.className = 'toast'; 
  if (type === 'success') {
    toast.classList.add('show', 'toast-success');
    toastIcon.className = 'fa-solid fa-circle-check';
    toastIcon.style.color = 'var(--success)';
  } else if (type === 'error') {
    toast.classList.add('show', 'toast-danger');
    toastIcon.className = 'fa-solid fa-circle-xmark';
    toastIcon.style.color = 'var(--danger)';
  }

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// 画面上の地図表示エリアにエラーメッセージを表示する (CORSや読み込みミス対策)
function showMapError(message, submessage) {
  const mapArea = document.querySelector('.map-area');
  if (!mapArea) return;

  // 既存のマップエラーがあれば削除
  const existingError = mapArea.querySelector('.map-error-overlay');
  if (existingError) {
    existingError.remove();
  }

  // エラーオーバーレイ要素を動的生成
  const errorOverlay = document.createElement('div');
  errorOverlay.className = 'map-error-overlay';
  errorOverlay.innerHTML = `
    <i class="fa-solid fa-triangle-exclamation map-error-icon"></i>
    <div class="map-error-text">${escapeHtml(message)}</div>
    <div class="map-error-subtext">${escapeHtml(submessage)}</div>
  `;

  mapArea.appendChild(errorOverlay);
}

// ----------------------------------------------------
// 12. グローバル window エクスポート (HTML内のインラインイベントハンドラ対応)
// ----------------------------------------------------
window.handleAddUser = handleAddUser;
window.switchMode = switchMode;
window.deleteUser = deleteUser;
window.confirmClearAll = confirmClearAll;
window.exportToCSV = exportToCSV;
window.focusOnMapRegion = focusOnMapRegion;
window.highlightMapRegion = highlightMapRegion;
window.toggleAccordion = toggleAccordion;
