import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  FlatList,
  Image,
} from 'react-native';
import RNFS from 'react-native-fs';

const numColumns = 2;

interface FilePickerProps {
  onSelect: (path: string) => void;
  initialDirectory?: string;
  showAllFolders?: boolean;
  receivedFiles?: Array<{ name: string; path: string; isImage: boolean; size: number }>;
  activeTab: 'browse' | 'received';
  browseRoot?: string;
  selectedPath?: string | null;
}

const ALLOWED_ROOT_FOLDERS = ["Document", "EXPORT", "MyStyle", "Note", "SCREENSHOT", "INBOX", "LocalSend", "Export"];

export const FilePicker: React.FC<FilePickerProps> = ({
  onSelect,
  initialDirectory = RNFS.ExternalStorageDirectoryPath,
  showAllFolders = false,
  receivedFiles = [],
  activeTab,
  browseRoot,
  selectedPath = null,
}) => {
  const [currentPath, setCurrentPath] = useState(browseRoot || initialDirectory);
  const [items, setItems] = useState<{ name: string; path: string; isDir: boolean }[]>([]);

  // When browseRoot changes (user clicked a dir chip), reset currentPath
  useEffect(() => {
    if (browseRoot) {
      setCurrentPath(browseRoot);
    } else {
      setCurrentPath(initialDirectory);
    }
  }, [browseRoot, initialDirectory]);

  useEffect(() => {
    if (activeTab === 'browse') {
      loadItems(currentPath);
    }
  }, [currentPath, activeTab]);

  const loadItems = async (path: string) => {
    try {
      const result = await RNFS.readDir(path);
      if (!result || !Array.isArray(result)) {
        setItems([]);
        return;
      }
      const mappedItems = result
        .map(item => ({
          name: item.name,
          path: item.path,
          isDir: item.isDirectory(),
        }))
        .filter(item => {
          if (item.name.startsWith('.')) return false;
          if (item.isDir) {
            if (!showAllFolders && path === initialDirectory) {
              return ALLOWED_ROOT_FOLDERS.includes(item.name);
            }
            return true;
          }
          return /\.(jpg|jpeg|png|bmp)$/i.test(item.name);
        })
        .sort((a, b) => (b.isDir === a.isDir ? a.name.localeCompare(b.name) : b.isDir ? 1 : -1));
      setItems(mappedItems);
    } catch (err) {
      console.error("Error reading directory:", err);
    }
  };

  const formatSize = (size: number): string => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isSelected = (path: string) => {
    if (!selectedPath) return false;
    const clean = selectedPath.replace('file://', '');
    return clean === path;
  };

  const renderBrowseItem = ({ item }: { item: any }) => (
    <Pressable
      style={[styles.gridItem, !item.isDir && isSelected(item.path) && styles.gridItemSelected]}
      onPress={() => item.isDir ? setCurrentPath(item.path) : onSelect(item.path)}
    >
      <View style={styles.thumbnailContainer}>
        {item.isDir ? (
          <View style={styles.folderContainer}>
            <Text style={styles.folderIcon}>[DIR]</Text>
          </View>
        ) : (
          <Image
            source={{ uri: `file://${item.path}` }}
            style={styles.thumbnail}
            resizeMode="cover"
          />
        )}
      </View>
      <View style={styles.textContainer}>
        <Text style={styles.itemText} numberOfLines={2}>
          {item.name}
        </Text>
      </View>
    </Pressable>
  );

  const renderReceivedItem = ({ item }: { item: any }) => (
    <Pressable
      style={[styles.gridItem, item.isImage && isSelected(item.path) && styles.gridItemSelected]}
      onPress={() => {
        if (item.isImage) {
          onSelect(item.path);
        }
      }}
    >
      <View style={styles.thumbnailContainer}>
        {item.isImage ? (
          <Image
            source={{ uri: `file://${item.path}` }}
            style={styles.thumbnail}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.folderContainer}>
            <Text style={styles.folderIcon}>[FILE]</Text>
          </View>
        )}
      </View>
      <View style={styles.textContainer}>
        <Text style={styles.itemText} numberOfLines={2}>
          {item.name}
        </Text>
        <Text style={styles.sizeText}>
          {formatSize(item.size)}
        </Text>
      </View>
    </Pressable>
  );

  const receivedImageFiles = receivedFiles.filter(f => f.isImage);

  return (
    <View style={styles.pickerContainer}>
      {activeTab === 'browse' ? (
        <FlatList
          data={items}
          key="browse-grid"
          keyExtractor={(item) => item.path}
          renderItem={renderBrowseItem}
          numColumns={numColumns}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>此目录没有图片文件</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={receivedImageFiles}
          key="received-grid"
          keyExtractor={(item) => item.path}
          renderItem={renderReceivedItem}
          numColumns={numColumns}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                还没有接收到图片文件{'\n'}
                从其他设备通过 LocalSend 发送图片即可在此查看
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
};

const gap = 10;

const styles = StyleSheet.create({
  pickerContainer: { flex: 1, backgroundColor: '#fff' },
  listContent: { padding: gap },
  gridItem: {
    flex: 1,
    margin: gap / 2,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 6,
    overflow: 'hidden',
  },
  gridItemSelected: {
    borderWidth: 3,
    borderColor: '#000000',
  },
  thumbnailContainer: {
    width: '100%',
    aspectRatio: 1.2,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#eee',
  },
  folderContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnail: { width: '100%', height: '100%' },
  folderIcon: { fontSize: 28, color: '#333', fontWeight: '600' },
  textContainer: {
    padding: 6,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderColor: '#D8D8D8',
    minHeight: 36,
    justifyContent: 'center',
  },
  itemText: {
    fontSize: 12,
    color: '#000',
    textAlign: 'center',
    fontWeight: '600',
  },
  sizeText: {
    fontSize: 10,
    color: '#666',
    textAlign: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 30,
  },
  emptyText: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    lineHeight: 22,
  },
});
