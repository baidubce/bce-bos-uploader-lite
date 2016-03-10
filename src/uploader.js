/**
 * Copyright (c) 2014 Baidu.com, Inc. All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 */

var sdk = require('baidubce-sdk');
var u = require('underscore');

var debug = require('debug')('bce-bos-uploader');

var kDefaultOptions = {
    runtimes: 'html5',
    bos_endpoint: 'http://bos.bj.baidubce.com',
    multi_selection: false,
    max_retries: 0,
    auto_start: false,
    max_file_size: '100mb',
    chunk_size: '4mb'
};

var kPostInit       = 'PostInit';

var kFilesRemoved   = 'FilesRemoved';
var kFileFiltered   = 'FileFiltered';
var kFilesAdded     = 'FilesAdded';

var kBeforeUpload   = 'BeforeUpload';
var kUploadFile     = 'UploadFile';       // ??
var kUploadProgress = 'UploadProgress';
var kFileUploaded   = 'FileUploaded';

var kError          = 'Error';
var kUploadComplete = 'UploadComplete';

/**
 * BCE BOS Uploader
 * @constructor
 * @param {Object} options 配置参数
 */
function Uploader(options) {
    // 已经支持的参数
    // options.runtimes
    // options.browse_button
    // options.uptoken_url
    // options.max_file_size
    // options.max_retries
    // options.chunk_size
    // options.auto_start
    // options.filters
    // options.bos_endpoint
    // options.multi_selection
    // options.init.FilesAdded
    // options.init.BeforeUpload
    // options.init.UploadProgress
    // options.init.FileUploaded
    // options.init.Error
    // options.init.UploadComplete

    // 暂时不支持的参数
    // options.get_new_uptoken
    // options.uptoken
    // options.unique_names
    // options.save_key
    // options.domain
    // options.container
    // options.flash_swf_url
    // options.dragdrop
    // options.drop_element
    // options.init.Key

    this.options = u.extend({}, kDefaultOptions, options);
    this.options.max_file_size = this._normalizeSize(this.options.max_file_size);
    this.options.chunk_size = this._normalizeSize(this.options.chunk_size);

    /**
     * @type {sdk.BosClient}
     */
    this.client = new sdk.BosClient({
        endpoint: this.options.bos_endpoint
    });
    this.client.createSignature = this._getCustomizedSignature(this.options.uptoken_url);

    /**
     * 需要等待上传的文件列表，每次上传的时候，从这里面删除
     * 成功或者失败都不会再放回去了
     * @param {Array.<File>}
     */
    this._files = [];

    /**
     * 当前正在上传的文件.
     * @type {File}
     */
    this._currentFile = null;

    /**
     * 是否被中断了，比如 this.stop
     * @type {boolean}
     */
    this._abort = false;

    /**
     * 是否处于上传的过程中，也就是正在处理 this._files 队列的内容.
     * @type {boolean}
     */
    this._working = false;

    this._init();
}

Uploader.prototype._normalizeSize = function (size) {
    // mb MB Mb M
    // kb KB kb k
    // 100
    var pattern = /^([\d\.]+)([mkg]b?)$/i;
    var match = pattern.exec(size);
    if (!match) {
        return 0;
    }

    var $1 = match[1];
    var $2 = match[2];
    if (/^k/i.test($2)) {
        return $1 * 1024;
    }
    else if (/^m/i.test($2)) {
        return $1 * 1024 * 1024;
    }
    else if (/^g/i.test($2)) {
        return $1 * 1024 * 1024;
    }
    return +$1;
};

Uploader.prototype._getCustomizedSignature = function (uptokenUrl) {
    return function (_, httpMethod, path, params, headers) {
        var deferred = sdk.Q.defer();
        $.ajax({
            url: uptokenUrl,
            jsonp: 'callback',
            dataType: 'jsonp',
            data: {
                httpMethod: httpMethod,
                path: path,
                delay: ~~(Math.random() * 10),
                params: JSON.stringify(params || {}),
                headers: JSON.stringify(headers || {})
            },
            success: function (payload) {
                if (payload.statusCode === 200 && payload.signature) {
                    deferred.resolve(payload.signature, payload.xbceDate);
                }
                else {
                    // TODO(leeight) timeout
                    deferred.reject(new Error('createSignature failed, statusCode = ' + payload.statusCode));
                }
            }
        });
        return deferred.promise;
    };
};

/**
 * 调用 this.options.init 里面配置的方法
 * @param {string} methodName 方法名称
 * @param {Array.<*>} args 调用时候的参数.
 */
Uploader.prototype._invoke = function (methodName, args) {
    var init = this.options.init || this.options.Init;
    if (!init) {
        return;
    }

    var method = init[methodName];
    if (typeof method !== 'function') {
        return;
    }

    try {
        method.apply(null, args == null ? [] : args);
    }
    catch (ex) {
        debug('%s(%j) -> %s', methodName, args, ex);
    }
};

/**
 * 初始化控件.
 */
Uploader.prototype._init = function () {
    var btn = $(this.options.browse_button);
    if (this.options.multi_selection) {
        btn.attr('multiple', true);
    }
    btn.on('change', u.bind(this._onFilesAdded, this));

    this.client.on('progress', u.bind(this._onUploadProgress, this));
    // 必须绑定 error 的处理函数，否则会 throw new Error
    this.client.on('error', u.bind(this._onError, this));

    this._invoke(kPostInit);
};

Uploader.prototype._filterFiles = function (candidates) {
    var self = this;

    // 如果 maxFileSize === 0 就说明不限制大小
    var maxFileSize = this.options.max_file_size;

    var files = u.filter(candidates, function (file) {
        if (maxFileSize > 0 && file.size > maxFileSize) {
            self._invoke(kFileFiltered, [null, file]);
            return false;
        }

        // TODO
        // 检查后缀之类的

        return true;
    });

    return files;
};

Uploader.prototype._onFilesAdded = function (e) {
    var files = this._filterFiles(e.target.files);
    if (files.length) {
        this._invoke(kFilesAdded, [null, files]);
        this._files.push.apply(this._files, files);
    }
    if (this.options.auto_start) {
        this.start();
    }
};

Uploader.prototype._onError = function (e) {
    debug(e);
    // this._invoke(kError, [null, e, this._currentFile]);
};

Uploader.prototype._onUploadProgress = function (e) {
    var progress = e.lengthComputable
                   ? e.loaded / e.total
                   : 0;
    this._invoke(kUploadProgress, [null, this._currentFile, progress, e]);
};

Uploader.prototype.start = function () {
    if (this._working) {
        return;
    }

    if (this._files.length) {
        this._working = true;
        this._uploadNext(this._getNext());
    }
};

Uploader.prototype.stop = function () {
    this._abort = true;
    this._working = false;
};

/**
 * 如果已经上传完毕了，返回 undefined
 *
 * @return {File|undefined}
 */
Uploader.prototype._getNext = function () {
    return this._files.shift();
};

Uploader.prototype._uploadNext = function (file, opt_maxRetries) {
    if (file == null || this._abort) {
        // 自动结束了 或者 人为结束了
        this._working = false;
        this._invoke(kUploadComplete);
        return;
    }

    this._currentFile = file;

    var bucket = this.options.bce_bucket;
    var object = file.name;

    var contentType = file.type;
    if (!contentType) {
        var ext = object.split(/\./g).pop();
        contentType = sdk.MimeType.guess(ext);
    }
    if (/^text\//.test(contentType)) {
        contentType += '; charset=UTF-8';
    }

    var options = {
        'Content-Type': contentType
    };

    var self = this;
    var maxRetries = opt_maxRetries == null
                     ? this.options.max_retries
                     : opt_maxRetries;
    this._invoke(kBeforeUpload, [null, file]);
    this.client.putObjectFromBlob(bucket, object, file, options)
        .then(function (response) {
            self._invoke(kFileUploaded, [null, file, response]);
            // 上传成功，开始下一个
            return self._uploadNext(self._getNext());
        })
        .catch(function (error) {
            self._invoke(kError, [null, error, file]);
            if (maxRetries > 0) {
                return self._uploadNext(file, maxRetries - 1);
            }
            else {
                // 重试结束了，不管了，继续下一个文件的上传
                return self._uploadNext(self._getNext());
            }
        });
};

module.exports = Uploader;










/* vim: set ts=4 sw=4 sts=4 tw=120: */