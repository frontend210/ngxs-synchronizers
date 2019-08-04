import { Store } from "@ngxs/store";
import { BehaviorSubject, forkJoin, merge, Observable, of, throwError, zip } from "rxjs";
import { catchError, distinctUntilChanged, filter, map, mergeMap, shareReplay, take, tap } from "rxjs/operators";
import { SyncState } from "./decorators/sync-state";
import { Synchronizer } from "./synchronizer";

type PendingStateRequestDictionary<T> = {
    [P in keyof T]?: Observable<T>;
};

export class StateSelector<T> {

    private readonly pendingRequests$ = new BehaviorSubject<PendingStateRequestDictionary<T>>({});

    constructor(
        private store: Store,
        private stateClass: SyncState.Class,
        private state$: Observable<T>,
        private synchronizers: Synchronizer.ICollection<T>
    ) {}

    public dispatch(propertyName: keyof T, value: T[typeof propertyName]): Observable<T> {
        const updateAction = SyncState.UpdateAction.For<T, T[typeof propertyName]>(this.stateClass);

        return this.store.dispatch(new updateAction(propertyName, value));
    }

    public property(propertyName: keyof T): Observable<T[typeof propertyName]> {
        return this.state$.pipe(map((state: T) => state[propertyName]));
    }

    public definedProperty(propertyName: keyof T): Observable<T[typeof propertyName]> {
        return this.property(propertyName).pipe(filter<T[typeof propertyName]>(Boolean));
    }

    public isSyncingProperty(propertyName: keyof T): Observable<boolean> {
        return this.getPropertyUpdater(propertyName).pipe(
            map(Boolean),
            distinctUntilChanged()
        );
    }

    public onPropertySyncing(propertyName: keyof T): Observable<keyof T> {
        return this.isSyncingProperty(propertyName).pipe(
            filter(Boolean),
            map(() => propertyName),
        );
    }

    public onPropertySynced(propertyName: keyof T): Observable<keyof T> {
        return this.isSyncingProperty(propertyName).pipe(
            filter(updating => !updating),
            map(() => propertyName)
        );
    }

    public onEveryPropertySyncing(...propertyNames: Array<keyof T>): Observable<Array<keyof T>> {
        return zip(...propertyNames.map(propertyName => this.onPropertySyncing(propertyName)));
    }

    public onEveryPropertySynced(...propertyNames: Array<keyof T>): Observable<Array<keyof T>> {
        return zip(...propertyNames.map(propertyName => this.onPropertySynced(propertyName)));
    }

    public onSomePropertySyncing(...propertyNames: Array<keyof T>): Observable<keyof T> {
        return merge(...propertyNames.map(propertyName => this.onPropertySyncing(propertyName)));
    }

    public onSomePropertySynced(...propertyNames: Array<keyof T>): Observable<keyof T> {
        return merge(...propertyNames.map(propertyName => this.onPropertySynced(propertyName)));
    }

    public require<OptsT = any>(propertyName: keyof T, options?: Synchronizer.Options<OptsT>): Observable<T>;
    public require<OptsT = any>(propertyNames: Array<keyof T>, options?: Synchronizer.Options<OptsT>): Observable<T>;

    public require<OptsT = any>(propertyNames: keyof T | Array<keyof T>, options?: Synchronizer.Options<OptsT>): Observable<T> {
        if (Array.isArray(propertyNames)) {
            return this.requireAll(propertyNames, options);
        } else {
            return this.requireOne(propertyNames, options);
        }
    }

    public requireProperty<OptsT = any>(propertyName: keyof T, options?: Synchronizer.Options<OptsT>): Observable<T[typeof propertyName]> {
        return this.requireOne<OptsT>(propertyName, options).pipe(map(session => session[propertyName]));
    }

    private requireOne<OptsT = any>(propertyName: keyof T, options?: Synchronizer.Options<OptsT>): Observable<T> {
        return this.state$.pipe(
            take(1),
            mergeMap(state => {
                if (state[propertyName]) {
                    return of(state);
                } else {
                    return this.sync<OptsT>(propertyName, options);
                }
            })
        );
    }

    private requireAll<OptsT = any>(propertyNames: Array<keyof T>, options?: Synchronizer.Options<OptsT>): Observable<T> {
        if (propertyNames.length === 0) {
            return this.state$.pipe(take(1));
        } else {
            const errors: any[] = [];
            return forkJoin(propertyNames.map(propertyName => {
                return this.requireOne(propertyName, options).pipe(
                    catchError((error) => {
                        errors.push(error);
                        return of(undefined);
                    })
                );
            })).pipe(
                mergeMap(() => {
                    if (errors.length === 0) {
                        return this.state$.pipe(take(1));
                    } else {
                        return throwError(`Error requiring properties: ${errors.join(", ")}`);
                    }
                })
            );
        }
    }

    public sync<OptsT = any>(propertyName: keyof T, options?: Synchronizer.Options<OptsT>): Observable<T>;
    public sync<OptsT = any>(propertyNames: Array<keyof T>, options?: Synchronizer.Options<OptsT>): Observable<T>;

    public sync<OptsT = any>(propertyNames: keyof T | Array<keyof T>, options?: Synchronizer.Options<OptsT>): Observable<T> {
        if (Array.isArray(propertyNames)) {
            return this.syncAll(propertyNames, options);
        } else {
            return this.syncOne(propertyNames, options);
        }
    }

    public syncProperty<OptsT = any>(propertyName: keyof T, options?: Synchronizer.Options<OptsT>): Observable<T[typeof propertyName]> {
        return this.syncOne<OptsT>(propertyName, options).pipe(map(session => session[propertyName]));
    }

    private syncOne<OptsT = any>(propertyName: keyof T, options?: Synchronizer.Options<OptsT>): Observable<T> {
        options = options || {};
        const errorPrefix = "Error: Cannot update session info:";
        const synchronizer = this.synchronizers.getSynchronizer(propertyName);

        // Check for cached values/pending requests only if this isn't a dependent requestor
        if (!synchronizer.proxy) {
            if (options.clearStore) {
                // TODO-Synchronize on this?
                this.dispatch(propertyName, undefined).subscribe();
            }

            if (synchronizer.requiredProperties && synchronizer.requiredProperties.some(requiredPropertyName => requiredPropertyName === propertyName)) {
                return throwError(`${errorPrefix} Synchronizer requires a reference to itself.`);
            }
        }

        return this.pendingRequests$.pipe(
            take(1),
            mergeMap((pendingRequests) => {
                let pendingRequest$ = pendingRequests[propertyName];

                if (pendingRequest$ && !options.clearStore) {
                    // Use the existing request if this value is currently being requested
                    return pendingRequest$;
                } else {
                    // First request any required fields needed to fetch the propertyName
                    if (synchronizer.proxy) {
                        pendingRequest$ = this.syncAll(synchronizer.requiredProperties, options);
                    } else {
                        pendingRequest$ = this.requireAll(synchronizer.requiredProperties || []);
                    }

                    // Then fetch the propertyName
                    pendingRequest$ = pendingRequest$.pipe(
                        mergeMap((requiredDetails: any) => synchronizer.read(requiredDetails, { propertyName, ...options })),
                        mergeMap((value: any) => this.dispatch(propertyName, value)), // Update the store value
                        catchError((error) => {
                            console.error(`Failed to request propertyName "${propertyName}": ${error}`);
                            this.clearPropertyUpdater(propertyName, pendingRequest$);
                            return throwError(error);
                        }),
                        tap(() => this.clearPropertyUpdater(propertyName, pendingRequest$)), // Remove the pending request
                        mergeMap(() => this.state$.pipe(take(1))), // Get the newly updated Session
                        shareReplay(1)
                    );

                    this.pendingRequests$.next(Object.assign(pendingRequests, { [propertyName]: pendingRequest$ }));
                    return pendingRequest$;
                }
            })
        );
    }

    private syncAll<OptsT = any>(propertyNames: Array<keyof T>, options?: Synchronizer.Options<OptsT>): Observable<T> {
        options = options || {};

        if (propertyNames.length === 0) {
            return this.state$.pipe(take(1));
        }

        // Update each required propertyName
        const errors: any[] = [];
        return forkJoin(propertyNames.map(name => this.sync<OptsT>(name, options).pipe(
            catchError((error) => {
                errors.push(error);
                return of(undefined);
            })))).pipe(
                mergeMap(() => {
                    if (errors.length === 0) {
                        return this.state$.pipe(take(1));
                    } else {
                        return throwError(`Error updating properties: ${errors.join(", ")}`);
                    }
                })
            );
    }

    private getPropertyUpdater(propertyName: keyof T): Observable<Observable<T> | undefined> {
        return this.pendingRequests$.pipe(map(pendingRequests => pendingRequests[propertyName]));
    }

    private clearPropertyUpdater(propertyName: keyof T, request: Observable<T>): void {
        this.pendingRequests$.pipe(
            take(1),
            filter(pendingRequests => pendingRequests[propertyName] === request)
        ).subscribe(pendingRequests => this.pendingRequests$.next(Object.assign(pendingRequests, { [propertyName]: undefined })));
    }
}
